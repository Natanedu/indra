import { ChannelState, convertChannelState } from './types'

export function hasPendingOps(stateAny: ChannelState<any>) {
  const state = convertChannelState('str', stateAny)
  for (let field in state) {
    if (!field.startsWith('pending'))
      continue
    if ((state as any)[field] != '0')
      return true
  }
  return false
}
