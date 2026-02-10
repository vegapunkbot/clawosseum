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

const privyAppId = ((import.meta as any)?.env?.VITE_PRIVY_APP_ID || '').toString().trim()

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
