import { NextRequest, NextResponse } from 'next/server'
import {createClient} from '@supabase/supabase-js'
import {lookup} from 'node:dns/promises'
import {isIP} from 'node:net'
export const runtime='nodejs'
export const dynamic='force-dynamic'
function validHost(h:string){return h.length<=253 && /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)}
function isPublicIp(ip:string){
 if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===192&&b===0)||(a===198&&(b===18||b===19)))}
 if(isIP(ip)===6){const s=ip.toLowerCase();return !(s==='::1'||s==='::'||s.startsWith('fc')||s.startsWith('fd')||s.startsWith('fe8')||s.startsWith('fe9')||s.startsWith('fea')||s.startsWith('feb')||s.startsWith('::ffff:'))}
 return false
}
async function safeHost(host:string){if(!validHost(host))return false;const addresses=await lookup(host,{all:true,verbatim:true});return addresses.length>0&&addresses.every(x=>isPublicIp(x.address))}
async function audit(host:string){
 let current=`https://${host}/`;const redirects:{from:string,to:string,status:number}[]=[];let code:number|null=null;let issue:string|null=null;const start=Date.now();
 try {
  for(let i=0;i<5;i++){
   const url=new URL(current)
   if(url.protocol!=='https:'||url.port||!(await safeHost(url.hostname))){issue='Unsafe or unsupported destination';break}
   // HEAD is sufficient for HTTP status and redirect auditing. No page content or credentials are fetched.
   const res=await fetch(url.toString(),{method:'HEAD',redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(6000),headers:{'user-agent':'DomainHealthCheck/1.0'}})
   code=res.status
   if([301,302,303,307,308].includes(code)){
    const location=res.headers.get('location');if(!location){issue='Redirect without Location';break}
    const next=new URL(location,url)
    if(next.protocol!=='https:'||next.username||next.password||next.port||!(await safeHost(next.hostname))){issue='Redirect to unsafe destination';break}
    redirects.push({from:current,to:next.toString(),status:code});current=next.toString();continue
   }
   if(code>=400)issue=`HTTP ${code}`
   break
  }
  if(redirects.length===5)issue='Redirect chain too long'
 } catch(e){issue=e instanceof Error?e.message.slice(0,200):'Network error'}
 return {status_code:code,final_url:current,redirects,issue,latency_ms:Date.now()-start}
}
export async function POST(req:NextRequest){
 try {
  const token=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')
  if(!token)return NextResponse.json({error:'Unauthorized'},{status:401})
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if(!url||!key)return NextResponse.json({error:'Not configured'},{status:503})
  const supabase=createClient(url,key,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false}})
  const {data:{user},error:authError}=await supabase.auth.getUser(token)
  if(authError||!user)return NextResponse.json({error:'Unauthorized'},{status:401})
  const body=await req.json();if(typeof body.domain_id!=='string')return NextResponse.json({error:'Invalid domain'},{status:400})
  const {data:domain}=await supabase.from('domains').select('id,hostname').eq('id',body.domain_id).eq('owner_id',user.id).single()
  if(!domain)return NextResponse.json({error:'Domain not found'},{status:404})
  const {data:last}=await supabase.from('domain_checks').select('checked_at').eq('domain_id',domain.id).order('checked_at',{ascending:false}).limit(1).maybeSingle()
  if(last && Date.now()-new Date(last.checked_at).getTime()<60000)return NextResponse.json({error:'Please wait 60 seconds between checks'},{status:429})
  const result=await audit(domain.hostname)
  const {error}=await supabase.from('domain_checks').insert({owner_id:user.id,domain_id:domain.id,...result})
  if(error)return NextResponse.json({error:error.message},{status:500})
  return NextResponse.json(result)
 }catch{return NextResponse.json({error:'Check failed'},{status:500})}
}
