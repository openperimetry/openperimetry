import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './AuthContext'
import { AdvancedSettingsRoot } from './advancedSettingsRoot'
import { StudyModeRoot } from './studyModeRoot'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdvancedSettingsRoot>
      <StudyModeRoot>
        <AuthProvider>
          <App />
        </AuthProvider>
      </StudyModeRoot>
    </AdvancedSettingsRoot>
  </StrictMode>,
)
