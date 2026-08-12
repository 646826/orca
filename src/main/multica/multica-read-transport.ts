import type {
  MulticaProcessInvocation,
  MulticaProcessResult
} from '../../shared/multica/multica-host-envelope'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import {
  buildMulticaCliInvocation,
  type MulticaCliReadOperation
} from './multica-cli-invocation'
import {
  MulticaCliResultError,
  parseMulticaCliJsonResult
} from './multica-cli-result'
import type { MulticaRestRequestOptions } from './multica-rest-client'

const MAX_CREDENTIAL_REF_LENGTH = 1024
const MAX_CREDENTIAL_LENGTH = 8192

export type MulticaReadTransportErrorCode = 'credential' | 'invalid-data'

export class MulticaReadTransportError extends Error {
  readonly code: MulticaReadTransportErrorCode

  constructor(code: MulticaReadTransportErrorCode, message: string) {
    super(message)
    this.name = 'MulticaReadTransportError'
    this.code = code
  }
}

export type MulticaCredentialResolver = (
  credentialRef: string
) => Promise<string | undefined> | string | undefined

export type MulticaRestReadInput = {
  profile: MulticaConnectionProfile
  token: string
  endpoint: string
  options: MulticaRestRequestOptions | undefined
}

export type MulticaCliReadInput = {
  profile: MulticaConnectionProfile
  invocation: MulticaProcessInvocation
}

export type MulticaRestReadExecutor = (input: MulticaRestReadInput) => Promise<unknown>
export type MulticaCliReadExecutor = (
  input: MulticaCliReadInput
) => Promise<MulticaProcessResult>

export type MulticaReadTransportOptions = {
  resolveCredential: MulticaCredentialResolver
  executeRest: MulticaRestReadExecutor
  executeCli: MulticaCliReadExecutor
}

export type MulticaJsonReadRequest<T> = {
  rest: {
    endpoint: string
    options?: MulticaRestRequestOptions
  }
  cli: {
    operation: MulticaCliReadOperation
    workspaceId?: string
    cwd?: string
  }
  validate: (value: unknown) => T
}

export class MulticaReadTransport {
  private readonly resolveCredential: MulticaCredentialResolver
  private readonly executeRest: MulticaRestReadExecutor
  private readonly executeCli: MulticaCliReadExecutor

  constructor(options: MulticaReadTransportOptions) {
    this.resolveCredential = options.resolveCredential
    this.executeRest = options.executeRest
    this.executeCli = options.executeCli
  }

  async readJson<T>(
    profile: MulticaConnectionProfile,
    request: MulticaJsonReadRequest<T>
  ): Promise<T> {
    if (profile.dataPlane.kind === 'rest') {
      return await this.readRestJson(profile, request)
    }
    return await this.readCliJson(profile, request)
  }

  private async readRestJson<T>(
    profile: MulticaConnectionProfile,
    request: MulticaJsonReadRequest<T>
  ): Promise<T> {
    if (profile.dataPlane.kind !== 'rest') {
      throw new Error('Expected a Multica REST profile')
    }

    const token = await this.requireCredential(profile.dataPlane.credentialRef)
    const value = await this.executeRest({
      profile,
      token,
      endpoint: request.rest.endpoint,
      options: request.rest.options
    })
    return validateReadValue(value, request.validate)
  }

  private async readCliJson<T>(
    profile: MulticaConnectionProfile,
    request: MulticaJsonReadRequest<T>
  ): Promise<T> {
    if (profile.dataPlane.kind !== 'cli') {
      throw new Error('Expected a Multica CLI profile')
    }

    const token =
      profile.dataPlane.credentialRef === undefined
        ? undefined
        : await this.requireCredential(profile.dataPlane.credentialRef)
    const invocation = buildMulticaCliInvocation(profile, request.cli.operation, {
      token,
      workspaceId: request.cli.workspaceId,
      cwd: request.cli.cwd
    })
    const result = await this.executeCli({ profile, invocation })

    try {
      return parseMulticaCliJsonResult(result, (value) =>
        validateReadValue(value, request.validate)
      )
    } catch (error) {
      if (error instanceof MulticaCliResultError && error.code === 'invalid-data') {
        throw invalidDataError()
      }
      throw error
    }
  }

  private async requireCredential(credentialRef: string): Promise<string> {
    if (!isSafeCredentialRef(credentialRef)) {
      throw credentialError()
    }

    try {
      const token = await this.resolveCredential(credentialRef)
      if (!isSafeCredential(token)) {
        throw credentialError()
      }
      return token
    } catch (error) {
      if (error instanceof MulticaReadTransportError && error.code === 'credential') {
        throw error
      }
      throw credentialError()
    }
  }
}

function validateReadValue<T>(value: unknown, validate: (value: unknown) => T): T {
  try {
    return validate(value)
  } catch {
    throw invalidDataError()
  }
}

function credentialError(): MulticaReadTransportError {
  return new MulticaReadTransportError(
    'credential',
    'Unable to resolve Multica credential'
  )
}

function invalidDataError(): MulticaReadTransportError {
  return new MulticaReadTransportError(
    'invalid-data',
    'Multica read response failed validation'
  )
}

function isSafeCredentialRef(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_CREDENTIAL_REF_LENGTH &&
    value.trim().length > 0 &&
    !containsControlCharacter(value)
  )
}

function isSafeCredential(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length <= MAX_CREDENTIAL_LENGTH &&
    value.trim().length > 0 &&
    !containsControlCharacter(value)
  )
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) {
      return true
    }
  }
  return false
}
