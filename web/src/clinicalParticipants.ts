import type { ClinicalParticipantRecord } from './api'

export type ClinicalParticipant = ClinicalParticipantRecord

export function makeSessionId(participantId: string, date = new Date()): string {
  const yyyymmdd = date.toISOString().slice(0, 10).replaceAll('-', '')
  return `${participantId}-${yyyymmdd}-01`
}
