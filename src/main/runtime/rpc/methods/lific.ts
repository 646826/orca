import { defineMethod, type RpcMethod } from '../core'
import {
  LificActivitySchema,
  LificAgentsMdSchema,
  LificCommentAddSchema,
  LificConnectSchema,
  LificContextSchema,
  LificDeleteCredentialSchema,
  LificDisconnectSchema,
  LificIssueGetSchema,
  LificIssueListSchema,
  LificIssueUpdateSchema,
  LificPageGetSchema,
  LificPageListSchema,
  LificBoardSchema,
  LificRelationSchema,
  LificPlanGetSchema,
  LificPlanListSchema,
  LificPlanStepUpdateSchema,
  LificProfileIdSchema,
  LificProfilePutSchema,
  LificRepoBindSchema,
  LificSearchSchema,
  LificStatusSchema,
  LificStoreCredentialSchema,
  LificWorkspaceBindSchema
} from '../../../../shared/lific/lific-rpc-contract'
import { getLificRuntimeService } from '../../../lific/lific-runtime-service'

export const LIFIC_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'lific.profiles',
    params: null,
    handler: () => getLificRuntimeService().listProfiles()
  }),
  defineMethod({
    name: 'lific.profile.put',
    params: LificProfilePutSchema,
    handler: (params) => getLificRuntimeService().putProfile(params.profile)
  }),
  defineMethod({
    name: 'lific.credential.store',
    params: LificStoreCredentialSchema,
    handler: (params) =>
      getLificRuntimeService().storeCredential(params.credentialRef, params.value)
  }),
  defineMethod({
    name: 'lific.credential.delete',
    params: LificDeleteCredentialSchema,
    handler: (params) => getLificRuntimeService().deleteCredential(params.credentialRef)
  }),
  defineMethod({
    name: 'lific.repo.bind',
    params: LificRepoBindSchema,
    handler: (params) => getLificRuntimeService().bindRepo(params)
  }),
  defineMethod({
    name: 'lific.workspace.bind',
    params: LificWorkspaceBindSchema,
    handler: (params) => getLificRuntimeService().bindWorkspace(params)
  }),
  defineMethod({
    name: 'lific.context',
    params: LificContextSchema,
    handler: (params) => getLificRuntimeService().context(params)
  }),
  defineMethod({
    name: 'lific.status',
    params: LificStatusSchema,
    handler: (params) => getLificRuntimeService().status(params.profileId)
  }),
  defineMethod({
    name: 'lific.connect',
    params: LificConnectSchema,
    handler: (params) => getLificRuntimeService().connect(params)
  }),
  defineMethod({
    name: 'lific.reconnect',
    params: LificConnectSchema,
    handler: (params) =>
      getLificRuntimeService().reconnect({
        profileId: params.profileId,
        agent: params.agent,
        agentProfileId: params.agentProfileId,
        scope: params.scope,
        authentication: params.authentication,
        ...(params.cwd ? { cwd: params.cwd } : {})
      })
  }),
  defineMethod({
    name: 'lific.disconnect',
    params: LificDisconnectSchema,
    handler: (params) =>
      getLificRuntimeService().disconnect(params.profileId, params.agentProfileId)
  }),
  defineMethod({
    name: 'lific.agentsMd',
    params: LificAgentsMdSchema,
    handler: (params) => getLificRuntimeService().agentsMd(params)
  }),
  defineMethod({
    name: 'lific.task.projects',
    params: LificProfileIdSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).listProjects()
  }),
  defineMethod({
    name: 'lific.task.issues',
    params: LificIssueListSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).listIssues({
        project: params.project,
        query: params.query,
        limit: params.limit
      })
  }),
  defineMethod({
    name: 'lific.task.issue',
    params: LificIssueGetSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).getIssue(params.identifier)
  }),
  defineMethod({
    name: 'lific.task.issue.update',
    params: LificIssueUpdateSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).updateIssue(
        params.identifier,
        params.update
      )
  }),
  defineMethod({
    name: 'lific.task.comments',
    params: LificIssueGetSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).listComments(params.identifier)
  }),
  defineMethod({
    name: 'lific.task.comment.add',
    params: LificCommentAddSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).addComment(
        params.identifier,
        params.content
      )
  }),
  defineMethod({
    name: 'lific.task.plans',
    params: LificPlanListSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).listPlans(
        params.projectId,
        params.status
      )
  }),
  defineMethod({
    name: 'lific.task.plan',
    params: LificPlanGetSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).getPlan(params.identifier)
  }),
  defineMethod({
    name: 'lific.task.plan-step.update',
    params: LificPlanStepUpdateSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).updatePlanStepById(
        params.planId,
        params.stepId,
        params.update
      )
  }),
  defineMethod({
    name: 'lific.task.activity',
    params: LificActivitySchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).listProjectActivity(
        params.projectId,
        params.limit
      )
  }),
  defineMethod({
    name: 'lific.task.search',
    params: LificSearchSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).search({
        query: params.query,
        projectId: params.projectId,
        resultType: params.resultType,
        limit: params.limit
      })
  }),
  defineMethod({
    name: 'lific.task.pages',
    params: LificPageListSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).listPages(params.projectId)
  }),
  defineMethod({
    name: 'lific.task.page',
    params: LificPageGetSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).getPage(params.identifier)
  }),
  defineMethod({
    name: 'lific.task.board',
    params: LificBoardSchema,
    handler: async (params) =>
      (await getLificRuntimeService().taskClient(params.profileId)).getBoard(params.projectId)
  }),
  defineMethod({
    name: 'lific.task.relation.link',
    params: LificRelationSchema,
    handler: async (params) => {
      await (
        await getLificRuntimeService().taskClient(params.profileId)
      ).linkIssues(params.source, params.target, params.relation)
      return { linked: true }
    }
  }),
  defineMethod({
    name: 'lific.task.relation.unlink',
    params: LificRelationSchema,
    handler: async (params) => {
      await (
        await getLificRuntimeService().taskClient(params.profileId)
      ).unlinkIssues(params.source, params.target, params.relation)
      return { unlinked: true }
    }
  })
]
