import { createClient } from '@supabase/supabase-js'
export function supabaseClient() {
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL
 const key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
 if(!url||!key) throw new Error('กรุณาตั้งค่า Supabase environment variables')
 return createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true}})
}
export type Domain = {id:string,owner_id:string,hostname:string,role:'primary'|'legacy'|'watch',notes:string|null,created_at:string}
export type Check = {id:string,domain_id:string,checked_at:string,status_code:number|null,final_url:string|null,redirects:unknown,issue:string|null,latency_ms:number|null}
export type Incident = {id:string,owner_id:string,title:string,kind:string,severity:string,reference_url:string|null,notes:string|null,created_at:string}
