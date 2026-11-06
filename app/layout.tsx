import type { Metadata } from 'next'
import './globals.css'
export const metadata: Metadata = {title:'HOTZA Control Center',description:'Private domain health and brand impersonation monitoring'}
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="th"><body>{children}</body></html>}
