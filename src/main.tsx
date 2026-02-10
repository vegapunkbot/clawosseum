import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './App.css'
import App from './App.tsx'

import { PrivyProvider } from '@privy-io/react-auth'

// Vite env vars are baked at build-time. On some Railway Docker builds, VITE_* vars are not
// available during the build stage, which would otherwise blank-screen the app.
// Privy App ID is *public* (not a secret), so we ship a safe fallback and still allow overrides.
const privyAppId = (
  ((import.meta as any)?.env?.VITE_PRIVY_APP_ID || '').toString().trim() ||
  // Fallback: clawosseum.fun Privy App ID
  'cmlfobtpl017hl40cni63n7x6'
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {privyAppId ? (
      <PrivyProvider
        appId={privyAppId}
        config={{
          // On mobile, wallet-based login often bounces users to install Phantom.
          // Prefer email/phone login + an embedded Solana wallet for a smooth onboarding.
          loginMethods: ['email', 'sms'],
          appearance: {
            theme: 'dark',
            walletChainType: 'solana-only',
            // Keep it obvious that embedded wallets are supported.
            showWalletLoginFirst: false,
          },
          embeddedWallets: {
            ethereum: { createOnLogin: 'off' },
            // Create a Privy embedded Solana wallet when a user logs in without one.
            solana: { createOnLogin: 'users-without-wallets' },
          },
        }}
      >
        <App />
      </PrivyProvider>
    ) : (
      <>
        <div style={{ padding: 12, background: '#3a1a1a', color: '#fff', fontFamily: 'system-ui' }}>
          Missing VITE_PRIVY_APP_ID. Privy features are disabled until configured.
        </div>
        <App />
      </>
    )}
  </StrictMode>,
)
