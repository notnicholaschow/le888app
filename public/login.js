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
