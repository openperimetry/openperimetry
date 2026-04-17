import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './AuthContext'
import { AdvancedSettingsRoot } from './advancedSettings'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdvancedSettingsRoot>
      <AuthProvider>
        <App />
      </AuthProvider>
    </AdvancedSettingsRoot>
  </StrictMode>,
)
