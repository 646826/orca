export type ConversationContextCapabilities =
  | { state: 'unverified' }
  | {
      state: 'verified'
      runtimeFingerprint: string
      acquisitionGeneration: string
      passiveImport: 'unsupported' | 'persisted-readback'
      firstTurnReceipt: 'unsupported' | 'live-acceptance' | 'persisted-readback'
      nonMutatingHydration: 'unsupported' | 'enforced'
      startupTrust: 'unverified' | 'approved'
      resume: 'unsupported' | 'native'
      artifactAccess: readonly ('text' | 'image' | 'host-retrieval')[]
      budget: 'unknown' | 'measured'
    }
