import { useCallback, useState, type ReactNode } from 'react'
import {
  STUDY_MODE_CTX,
  STUDY_MODE_SET_CTX,
  loadStudyMode,
  saveStudyMode,
  type StudyModeState,
} from './studyMode'

export function StudyModeRoot({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StudyModeState>(() => loadStudyMode())
  const update = useCallback((next: StudyModeState) => {
    setState(next)
    saveStudyMode(next)
  }, [])
  return (
    <STUDY_MODE_SET_CTX.Provider value={update}>
      <STUDY_MODE_CTX.Provider value={state}>{children}</STUDY_MODE_CTX.Provider>
    </STUDY_MODE_SET_CTX.Provider>
  )
}
