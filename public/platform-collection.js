/* Layout 1 platform collection. Presentation only; destination URLs remain admin-managed. */
(() => {
  const platforms = [
    ['918kiss', '918Kiss', '194,74,104'], ['mega888', 'Mega888', '78,139,188'],
    ['pussy888', 'Pussy888', '190,108,51'], ['918kaya', '918Kaya', '141,94,139'],
    ['live22', 'Live22', '114,166,191'], ['ace333', 'ACE333', '210,170,59'],
    ['evo888', 'EVO888', '190,158,86'], ['king855', 'King855', '194,161,70']
  ];
  let selected = 1;
  const label = i => String(i + 1).padStart(2, '0');
  const art = id => ['918kiss','918kaya'].includes(id) ? 'rose' : ['mega888','live22'].includes(id) ? 'blue' : 'gold';
  function markup() {
    return `<section class="pc-collection pc-deck" aria-labelledby="pc-title">
      <div class="pc-rule" aria-hidden="true"><i></i></div>
      <div class="pc-heading"><h2 id="pc-title">Platform Lounge</h2></div><div class="os-stage-topline pc-topline"><span><i></i> THE COLLECTION</span><span class="pc-total">08 PLATFORMS</span></div>
      <div class="pc-stage" tabindex="0" role="region" aria-roledescription="carousel" aria-label="Game platforms. Use left and right arrow keys or swipe.">
        <div class="pc-floor" aria-hidden="true"></div>
        <div class="pc-aura" aria-hidden="true"></div>
        ${platforms.map(([id,name,color],i)=>`<article class="pc-card" data-pc-card="${i}" style="--pc-tint:${color};--pc-art:url('/assets/pc-fused-${id}-v8.webp')" aria-label="${name}">
          <button type="button" class="pc-card-select" aria-label="Select ${name}"></button>
          <span class="pc-scenery" aria-hidden="true"></span><span class="pc-index">${label(i)} <i>/ 08</i></span>
          <span class="pc-reveal-light" aria-hidden="true"></span>
                              <span class="pc-card-bottom"><span><small>PLATFORM</small><strong>${name}</strong></span></span>
          <button type="button" class="pc-explore pc-card-explore" aria-label="Explore ${name}"><span>Explore ${name}</span><span aria-hidden="true">↗</span></button>
        </article>`).join('')}
      </div>
      <div class="pc-navigation"><button type="button" data-pc-step="-1" aria-label="Previous platform">‹</button><button type="button" class="pc-dial" data-pc-step="1" aria-label="Next platform"><i aria-hidden="true"></i><span>02</span><small>/ 08</small></button><div class="pc-selector-copy"><span class="pc-swipe-label">SWIPE TO EXPLORE</span><div class="pc-ticks">${platforms.map((p,i)=>`<button type="button" data-pc-select="${i}" aria-label="Select ${p[1]}"><i></i></button>`).join('')}</div></div><button type="button" data-pc-step="1" aria-label="Next platform">›</button></div>
      
      <nav class="pc-names" aria-label="Choose a platform">${platforms.map((p,i)=>`<button type="button" data-pc-select="${i}">${p[1]}</button>`).join('')}</nav>
      <span class="pc-announcement" role="status" aria-live="polite"></span>
    </section>`;
  }
  function update(section, announce = true, tint = true) {
    // The glow colour is only changed when the deck is at rest (changing it repaints big gradients).
    if(tint) section.style.setProperty('--pc-active-tint', platforms[selected][2]);
    section.querySelector('.pc-dial > span').textContent=label(selected);
    section.querySelector('.pc-dial > i').style.transform='rotate('+selected*45+'deg)';
    section.querySelectorAll('[data-pc-card]').forEach((card,i)=>{
      let offset = (i - selected + platforms.length) % platforms.length;
      if(offset > platforms.length / 2) offset -= platforms.length;
      card.classList.toggle('pc-selected',offset===0);
      card.querySelector('.pc-card-select').tabIndex = offset===0 ? 0 : -1;
      card.querySelector('.pc-card-select').setAttribute('aria-label','Select '+platforms[i][1]);
      card.querySelector('.pc-card-explore').tabIndex = offset===0 ? 0 : -1;
      card.setAttribute('aria-hidden',String(offset!==0));
      card.querySelector('.pc-card-select').setAttribute('aria-pressed',String(offset===0));
    });
    section.querySelectorAll('[data-pc-select]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.pcSelect)===selected)));
    if(announce) section.querySelector('.pc-announcement').textContent = `${platforms[selected][1]}, platform ${selected+1} of 8`;
  }
  // Smooth, endless deck: one continuous position (pos) drives every card each
  // frame, so the deck follows the finger exactly and loops 8 -> 1 -> 2 forever.
  function wire(section) {
    const stage=section.querySelector('.pc-stage');
    const cards=[...section.querySelectorAll('.pc-card')];
    const N=cards.length;
    const reduce=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wrapD=d=>{d=((d%N)+N)%N;if(d>=N/2)d-=N;return d;};
    let pos=selected, goal=selected, anim=0, drag=null, suppressUntil=0, W=0, raf=0;
    // A see-through dark layer per card (cheap to fade) replaces the old brightness filter.
    const dims=cards.map(c=>{let d=c.querySelector('.pc-dim');if(!d){d=document.createElement('span');d.className='pc-dim';d.setAttribute('aria-hidden','true');c.appendChild(d);}return d;});
    const last=cards.map(()=>({t:'',z:'',o:'',d:''}));
    const measure=()=>{W=cards[0].offsetWidth||220;};
    section.classList.add('pc-fast');
    let revealAnimations=[];
    const stopReveal=()=>{revealAnimations.forEach(a=>a.cancel());revealAnimations=[];};
    const reveal=()=>{
      stopReveal();
      if(reduce())return;
      const card=section.querySelector('.pc-selected');if(!card)return;
      const animate=(selector,frames,delay,duration)=>{const el=card.querySelector(selector);if(el)revealAnimations.push(el.animate(frames,{duration,delay,easing:'cubic-bezier(.2,.75,.2,1)',fill:'backwards'}));};
      animate('.pc-card-bottom',[{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],60,380);
      animate('.pc-card-explore',[{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}],120,380);
      animate('.pc-reveal-light',[{opacity:0,transform:'translateX(-130%) skewX(-18deg)'},{opacity:.5,offset:.35},{opacity:0,transform:'translateX(180%) skewX(-18deg)'}],40,800);
    };
    function paint(){
      if(!W)measure();
      cards.forEach((c,i)=>{
        const d=wrapD(i-pos), a=Math.abs(d), s=d<0?-1:1;
        let x,y,rz,sc,z,op=1;
        if(a<1){ // the two cards swapping: they swing out to opposite sides, then trade places
          const k=Math.sin(Math.PI*a);
          x=s*(k*W*.62+8*a); y=9-4*a-k*10; rz=s*(k*10+4*a); sc=1-.035*a; z=a<.5?500:390-Math.round(a*10);
        }else{ // resting fan behind the front card
          x=d*8; y=9-4*a; rz=d*4; sc=1-.035*a; z=380-Math.round(a*40); op=a>3.6?0:1;
        }
        const t='translate3d('+x.toFixed(1)+'px,'+y.toFixed(1)+'px,0) rotate('+rz.toFixed(2)+'deg) scale('+sc.toFixed(4)+')';
        const L=last[i], zs=String(z), os=String(op), ds=Math.min(.5,a*.45).toFixed(2);
        if(L.t!==t){c.style.transform=t;L.t=t;}
        if(L.z!==zs){c.style.zIndex=zs;L.z=zs;}
        if(L.o!==os){c.style.opacity=os;L.o=os;}
        if(L.d!==ds){dims[i].style.opacity=ds;L.d=ds;}
      });
      const sel=((Math.round(pos)%N)+N)%N;
      if(sel!==selected){selected=sel;update(section,true,!drag&&!anim);}
    }
    const paintSoon=()=>{if(!raf)raf=requestAnimationFrame(()=>{raf=0;paint();});};
    function animateTo(target,dur){
      cancelAnimationFrame(anim);stopReveal();
      const from=pos;goal=target;
      const done=()=>{anim=0;pos=goal=((Math.round(target)%N)+N)%N;paint();update(section,false,true);reveal();};
      if(reduce()||Math.abs(target-from)<.001){pos=target;done();return;}
      dur=dur||Math.min(820,340+120*Math.abs(target-from));
      const t0=performance.now();
      const step=now=>{const t=Math.min(1,(now-t0)/dur);const e=1-Math.pow(1-t,3);pos=from+(target-from)*e;paint();if(t<1)anim=requestAnimationFrame(step);else done();};
      anim=-1;
      anim=requestAnimationFrame(step);
    }
    // Taps while the deck is still moving add on to where it is heading, so none are lost.
    const choose=n=>animateTo(goal+wrapD(n-goal));
    const stepBy=k=>animateTo(Math.round(goal)+k);

    section.addEventListener('click',e=>{
      if(Date.now()<suppressUntil)return;
      if(e.target.closest('.pc-explore')){
        // Reuse the existing platform directory and its admin-maintained links.
        window.pcRequestedPlatform=platforms[selected][0];
        if(typeof go==='function')go('platforms');
        return;
      }
      const step=e.target.closest('[data-pc-step]');
      if(step){stepBy(Number(step.dataset.pcStep));return;}
      const sel=e.target.closest('[data-pc-select],[data-pc-card]');
      if(sel)choose(Number(sel.dataset.pcSelect ?? sel.dataset.pcCard));
    });
    stage.addEventListener('keydown',e=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
      e.preventDefault();
      if(e.key==='Home')choose(0);else if(e.key==='End')choose(N-1);else stepBy(e.key==='ArrowRight'?1:-1);
      stage.focus({preventScroll:true});
    });

    // Finger / mouse dragging with momentum.
    const width=()=>(W||(measure(),W))*.9;
    stage.addEventListener('pointerdown',e=>{
      if(!e.isPrimary||(e.pointerType==='mouse'&&e.button!==0)||drag)return;
      drag={id:e.pointerId,x:e.clientX,y:e.clientY,startPos:pos,moving:false,samples:[{t:performance.now(),x:e.clientX}]};
    });
    stage.addEventListener('pointermove',e=>{
      if(!drag||drag.id!==e.pointerId)return;
      const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
      if(!drag.moving){
        if(Math.max(Math.abs(dx),Math.abs(dy))<6)return;
        if(Math.abs(dy)>Math.abs(dx)){drag=null;return;} // vertical: let the page scroll
        drag.moving=true;cancelAnimationFrame(anim);anim=0;stopReveal();measure();
        drag.startPos=pos;drag.base=goal;drag.x=e.clientX;drag.x0=e.clientX; // start from where the deck is right now (even mid-animation)
        stage.classList.add('pc-dragging');
        try{stage.setPointerCapture(e.pointerId);}catch(err){}
      }
      const now=performance.now();
      drag.samples.push({t:now,x:e.clientX});while(drag.samples.length>2&&now-drag.samples[0].t>120)drag.samples.shift();
      pos=drag.startPos-(e.clientX-drag.x)/width();
      paintSoon(); // at most one redraw per screen refresh
    });
    const release=(e,cancel)=>{
      if(!drag||drag.id!==e.pointerId)return;
      const g=drag;drag=null;
      if(!g.moving)return;
      stage.classList.remove('pc-dragging');
      try{if(stage.hasPointerCapture(e.pointerId))stage.releasePointerCapture(e.pointerId);}catch(err){}
      suppressUntil=Date.now()+350;
      const a=g.samples[0],b=g.samples[g.samples.length-1];
      const v=b.t>a.t?(b.x-a.x)/(b.t-a.t):0; // px per ms
      let target=Math.round(pos-(cancel?0:v*170/width()));
      const base=Math.round(g.base);
      const moved=e.clientX-g.x0, dir=moved<0?1:-1;
      // A real flick (not just a wobble) always moves at least one card, even mid-animation.
      if(!cancel&&(Math.abs(moved)>24||Math.abs(v)>.3))target=dir>0?Math.max(target,base+1):Math.min(target,base-1);
      target=Math.max(base-2,Math.min(base+2,target)); // a hard flick moves at most 2 cards
      animateTo(target);
    };
    stage.addEventListener('pointerup',e=>release(e,false));
    stage.addEventListener('pointercancel',e=>release(e,true));
    stage.addEventListener('lostpointercapture',e=>{if(e.target===stage&&drag&&drag.moving)release(e,false);});
    window.addEventListener('resize',()=>{measure();paint();});
    update(section,false);
    paint();
  }
  const previousRender=render;
  render=function(){
    previousRender();
    if(state.page==='home'){
      const miniStage=document.querySelector('.os-stage-shell');
      if(miniStage && !miniStage.querySelector('.pc-mini-heading')) miniStage.insertAdjacentHTML('afterbegin','<h2 class="pc-mini-heading">Signature Games</h2>');
      // Slots first: banner + Platform Lounge go right under the Deposit / Withdraw / Wallet / VIP buttons,
      // above the mini games, so players see the slot platforms before the free-credit games.
      const dock=document.querySelector('.os-action-dock');
      if(dock && !document.querySelector('.pc-collection')){
        dock.insertAdjacentHTML('afterend','<button type="button" class="pc-banner" aria-label="See all slot platforms"><img src="/assets/slot-banner.webp" alt="LE888 slot platforms" onerror="this.parentNode.remove()"></button>'+markup());
        const sec=document.querySelector('.pc-collection');wire(sec);
        const ban=document.querySelector('.pc-banner');
        if(ban)ban.onclick=()=>{const st=sec.querySelector('.pc-heading')||sec;const hd=document.querySelector('#header');const off=(hd?hd.getBoundingClientRect().bottom:0)+12;window.scrollTo({top:st.getBoundingClientRect().top+window.scrollY-off,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});};
      }
    }
    if(state.page==='platforms' && window.pcRequestedPlatform){
      const card=[...document.querySelectorAll('.gp-card')].find(c=>c.querySelector('.gp-info b')?.textContent.toLowerCase().replace(/[^a-z0-9]/g,'')===window.pcRequestedPlatform);
      if(card){card.classList.add('pc-destination');card.tabIndex=-1;requestAnimationFrame(()=>{card.scrollIntoView({block:'center',behavior:'auto'});card.focus({preventScroll:true});});window.pcRequestedPlatform=null;}
    }
  };
  render();
})();
