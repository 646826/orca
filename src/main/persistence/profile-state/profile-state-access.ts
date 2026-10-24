import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  ProfileStateAccessError,
  hasCode,
  profileStateAccessPaths,
  publishAccessOwner,
  reclaimExitedOwner
} from './profile-state-access-owner'
export { ProfileStateAccessError } from './profile-state-access-owner'

export type ProfileStateRuntimeAdmission = {
  assertActive(): void
  release(): void
}

export type ProfileStateMaintenance = ProfileStateRuntimeAdmission & {
  assertProfile(profileId: string, dataFile: string, databasePath: string): void
}

const maintenanceRoots = new WeakMap<ProfileStateMaintenance, string>()
const runtimeAdmissions = new Map<string, Map<string, ProfileStateRuntimeAdmission>>()

/** Bind destructive operations to a genuine, live maintenance owner for these exact profile paths. */
export function assertProfileStateMaintenance(
  maintenance: ProfileStateMaintenance,
  profile: { profileId: string; dataFile: string; databasePath: string }
): void {
  const root = maintenanceRoots.get(maintenance)
  if (root === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profile.profileId)) {
    throw new ProfileStateAccessError(
      'Profile state recovery requires an acquired maintenance owner'
    )
  }
  maintenance.assertActive()
  const expectedDirectory = join(root, 'profiles', profile.profileId)
  for (const [path, expectedName] of [
    [profile.dataFile, 'orca-data.json'],
    [profile.databasePath, 'profile-state.db']
  ] as const) {
    if (
      !samePath(realpathSync(dirname(path)), expectedDirectory) ||
      !samePath(basename(path), expectedName)
    ) {
      throw new ProfileStateAccessError(
        'Profile state recovery paths do not belong to the maintenance root'
      )
    }
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new ProfileStateAccessError('Profile state recovery cannot replace a symbolic link')
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) {
        throw error
      }
    }
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Admit before any profile read, and retain until every Store and worker has stopped. */
export function acquireProfileStateRuntimeAdmission(
  userDataPath: string
): ProfileStateRuntimeAdmission {
  const paths = profileStateAccessPaths(userDataPath)
  const owner = publishAccessOwner(paths, false)
  try {
    reclaimExitedOwner(paths.maintenance)
    const root = dirname(paths.root)
    const admissions =
      runtimeAdmissions.get(root) ?? new Map<string, ProfileStateRuntimeAdmission>()
    const admission: ProfileStateRuntimeAdmission = {
      assertActive: () => owner.assertActive(),
      release(): void {
        owner.release()
        admissions.delete(owner.token)
        if (admissions.size === 0 && runtimeAdmissions.get(root) === admissions) {
          runtimeAdmissions.delete(root)
        }
      }
    }
    admissions.set(owner.token, admission)
    runtimeAdmissions.set(root, admissions)
    return admission
  } catch (error) {
    owner.release()
    throw error
  }
}

/** Exempts only this runtime's genuine admission while excluding old-schema writers. */
export function withProfileStateRuntimeMigration<T>(userDataPath: string, run: () => T): T {
  const root = realpathSync(userDataPath)
  const admissions = runtimeAdmissions.get(root)
  const self = admissions?.size === 1 ? admissions.entries().next().value : undefined
  if (!self) {
    throw new ProfileStateAccessError(
      'Schema migration requires exactly one live runtime admission'
    )
  }
  const [token, admission] = self
  admission.assertActive()
  const paths = profileStateAccessPaths(root)
  const maintenance = publishAccessOwner(paths, true)
  try {
    for (const entry of readdirSync(paths.participants)) {
      if (entry !== token) {
        reclaimExitedOwner(join(paths.participants, entry))
      }
    }
    admission.assertActive()
    const result = run()
    if (result instanceof Promise) {
      throw new ProfileStateAccessError('Schema migration must complete synchronously')
    }
    return result
  } finally {
    maintenance.release()
  }
}

/** Exclude startup and all participating readers/writers through durable recovery publication. */
export function acquireProfileStateMaintenance(userDataPath: string): ProfileStateMaintenance {
  const paths = profileStateAccessPaths(userDataPath)
  const owner = publishAccessOwner(paths, true)
  try {
    for (const entry of readdirSync(paths.participants)) {
      reclaimExitedOwner(join(paths.participants, entry))
    }
    const maintenance: ProfileStateMaintenance = {
      ...owner,
      assertProfile(profileId, dataFile, databasePath): void {
        assertProfileStateMaintenance(maintenance, { profileId, dataFile, databasePath })
      }
    }
    maintenanceRoots.set(maintenance, dirname(paths.root))
    return maintenance
  } catch (error) {
    owner.release()
    throw error
  }
}
