import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './App.css'
import '@solana/wallet-adapter-react-ui/styles.css'
import App from './App.tsx'

import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets'
import { clusterApiUrl } from '@solana/web3.js'

const endpoint = clusterApiUrl('devnet')
const wallets = [new PhantomWalletAdapter(), new SolflareWalletAdapter()]

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
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {privyAppId ? (
            <PrivyProvider
              appId={privyAppId}
              config={{
                // Keep UI minimal; wallet connection already exists for claim.
                loginMethods: ['wallet'],
                appearance: { theme: 'dark' },
                embeddedWallets: { solana: { createOnLogin: 'off' } },
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
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </StrictMode>,
)
