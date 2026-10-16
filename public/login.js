/* PWA: turn on the LE888 service worker (installable app + offline screen). */
if('serviceWorker' in navigator)window.addEventListener('load',()=>{navigator.serviceWorker.register('/sw.js').catch(()=>{});});
const form=document.querySelector('#member-login-form'),error=document.querySelector('#login-error'),password=document.querySelector('#password');
document.querySelector('#show-password').onclick=e=>{const show=password.type==='password';password.type=show?'text':'password';e.currentTarget.textContent=show?'Hide':'Show';e.currentTarget.setAttribute('aria-label',show?'Hide password':'Show password');e.currentTarget.setAttribute('aria-pressed',String(show));};
document.querySelector('#forgot-password').onclick=()=>{document.querySelector('#recovery-note').hidden=false;};
if(new URLSearchParams(location.search).get('password')==='changed')error.textContent='Password updated. Please sign in with your new password.';
form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='Signing in…';error.textContent='';try{const r=await fetch('/api/member/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.username.value.trim(),password:password.value})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Unable to sign in');location.replace('/#home');}catch(err){error.textContent=err.message==='Failed to fetch'?'Connection unavailable. Please try again.':err.message;button.disabled=false;button.innerHTML='Log In <span aria-hidden="true">→</span>';}};
window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});

/* Contact buttons (WhatsApp / Telegram) - links set in Admin -> Settings, shown only when filled in. */
(async()=>{try{const box=document.querySelector('#login-contact');if(!box)return;const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store'});const c=await r.json();
 const esc=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
 const ok=u=>/^https:\/\//i.test(String(u||''));
 const IC={wa:'<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M12 2.2a9.7 9.7 0 0 0-8.4 14.6L2.3 21.7l5-1.3A9.7 9.7 0 1 0 12 2.2zm0 1.8a7.9 7.9 0 1 1-4.1 14.7l-.3-.2-3 .8.8-2.9-.2-.3A7.9 7.9 0 0 1 12 4z"/><path fill="#fff" d="M9.1 7.4c-.2-.4-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.3.3-.9.9-.9 2.2s.9 2.5 1 2.7c.1.2 1.8 2.9 4.5 4 2.2.9 2.7.7 3.1.7.5 0 1.6-.6 1.8-1.3.2-.6.2-1.2.2-1.3-.1-.1-.3-.2-.6-.3l-1.9-.9c-.3-.1-.5-.1-.7.1l-.8 1c-.1.2-.3.2-.6.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.6-1.5-1.8-.1-.3 0-.4.1-.5l.4-.5.3-.4v-.5l-.9-2.2z"/></svg>',tg:'<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M20.7 4.3 2.9 11.2c-1.2.5-1.2 1.2-.2 1.5l4.6 1.4 1.7 5.4c.2.6.4.8.8.8s.6-.2.9-.5l2.2-2.1 4.6 3.4c.8.5 1.4.2 1.6-.8l3-14.2c.3-1.2-.5-1.8-1.4-1.3zM8.5 13.7l9.7-6.1c.5-.3.9-.1.5.2l-8 7.3-.3 3.4-1.9-4.8z"/></svg>'};
 const btns=[];if(ok(c.contact_whatsapp))btns.push(['wa','WhatsApp',c.contact_whatsapp]);if(ok(c.contact_telegram))btns.push(['tg','Telegram',c.contact_telegram]);
 if(!btns.length&&ok(c.contact_url))btns.push(['', 'Contact us',c.contact_url]);
 if(!btns.length)return;
 box.innerHTML='<span class="lc-label">Contact us</span><div class="lc-row'+(btns.length===1?' one':'')+'">'+btns.map(([k,n,u])=>`<a class="lc-btn ${k?'lc-'+k:''}" href="${esc(u)}" target="_blank" rel="noopener">${k?`<span class="lc-ic">${IC[k]}</span>`:''}<b>${n}</b></a>`).join('')+'</div>';
 box.hidden=false;}catch(e){}})();

/* ---- Self sign-up ---------------------------------------------------- */
(()=>{const $=s=>document.querySelector(s);const loginP=$('#login-panel'),suP=$('#signup-panel'),doneP=$('#signup-done'),f=$('#signup-form'),err=$('#signup-error');if(!suP||!f)return;
 const note=$('.access-note'),rec=$('#recovery-note');
 const show=w=>{loginP.hidden=w!=='login';suP.hidden=w!=='signup';doneP.hidden=w!=='done';if(note)note.hidden=w!=='login';if(rec&&w!=='login')rec.hidden=true;window.scrollTo({top:0,behavior:'smooth'});};
 $('#open-signup').onclick=()=>{show('signup');history.replaceState(null,'','#signup');setTimeout(()=>$('#su-name').focus(),250);};
 $('#back-to-login').onclick=()=>{show('login');history.replaceState(null,'',location.pathname+location.search);};
 if(location.hash==='#signup')show('signup');
 document.querySelectorAll('.su-show').forEach(b=>b.onclick=()=>{const i=document.getElementById(b.dataset.for);const s=i.type==='password';i.type=s?'text':'password';$('#su-pass2').type=i.type;b.textContent=s?'Hide':'Show';});
 // Hide the button if sign-up is switched off in Admin -> Settings.
 fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store'}).then(r=>r.json()).then(c=>{if(c&&c.signup_enabled===false){$('#open-signup').hidden=true;const n=$('#signup-closed-note');if(n)n.hidden=false;if(!suP.hidden)show('login');}}).catch(()=>{});
 const fail=(msg,el)=>{err.textContent=msg;f.querySelectorAll('.bad').forEach(x=>x.classList.remove('bad'));if(el){el.classList.add('bad');el.focus();}};
 const refCode=(()=>{const q=new URLSearchParams(location.search).get('ref');const c=(document.cookie.match(/(?:^|;\s*)le888ref=([^;]+)/)||[])[1];const r=String(q||(c?decodeURIComponent(c):'')||'').trim().toUpperCase();return /^[A-Z0-9_.]{3,32}$/.test(r)?r:'';})();
 if(refCode){const box=$('#su-ref');if(box){box.innerHTML='<span class="su-ref-ic" aria-hidden="true">🎁</span><span>Invited by <b>'+refCode+'</b></span>';box.hidden=false;}if(location.hash!=='#signup'&&new URLSearchParams(location.search).get('ref'))show('signup');}
 f.onsubmit=async e=>{e.preventDefault();const v=id=>$(id).value.trim();
  const digits=v('#su-phone').replace(/\D/g,'');
  if(v('#su-name').length<2)return fail('Please enter your full name.',$('#su-name'));
  if(/^[3689]\d{7}$/.test(digits))return fail('Please add the country code 65 in front, e.g. 65'+digits+'.',$('#su-phone'));if(digits.length<10||digits.length>15||(/^65/.test(digits)&&!/^65[3689]\d{7}$/.test(digits)))return fail('Please enter your phone number with country code, e.g. 6591234567 (no + needed).',$('#su-phone'));
  if(v('#su-paynow').replace(/[^0-9A-Za-z]/g,'').length<8)return fail('Please enter your PayNow number.',$('#su-paynow'));
  if(!v('#su-bank'))return fail('Please choose your bank.',$('#su-bank'));
  if(!v('#su-holder'))return fail('Please enter the name on your bank account.',$('#su-holder'));
  if(v('#su-acc').replace(/[^0-9A-Za-z]/g,'').length<5)return fail('Please enter your bank account number.',$('#su-acc'));
  if($('#su-pass').value.length<8)return fail('Password must be at least 8 characters.',$('#su-pass'));
  if($('#su-pass').value!==$('#su-pass2').value)return fail('The two passwords do not match.',$('#su-pass2'));
  fail('');const btn=f.querySelector('[type="submit"]');btn.disabled=true;btn.textContent='Creating your account…';
  try{const r=await fetch('/api/member/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:v('#su-name'),phone:digits,paynow:v('#su-paynow'),bank_type:v('#su-bank'),bank_holder:v('#su-holder'),bank_account:v('#su-acc'),password:$('#su-pass').value,ref:refCode})});
   const d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new Error(d.error||'Could not create your account. Please try again.');
   $('#su-new-id').textContent=d.username;show('done');history.replaceState(null,'',location.pathname);
  }catch(x){fail(x.message==='Failed to fetch'?'Connection unavailable. Please try again.':x.message);btn.disabled=false;btn.innerHTML='Create account <span aria-hidden="true">→</span>';}};
 $('#su-copy').onclick=()=>{const t=$('#su-new-id').textContent;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>{$('#su-copy').textContent='Copied';},()=>{});};
 $('#su-enter').onclick=()=>location.replace('/#home');
})();
