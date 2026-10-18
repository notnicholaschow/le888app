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
  function update(section, announce = true) {
    section.style.setProperty('--pc-active-tint', platforms[selected][2]);
    section.querySelector('.pc-dial > span').textContent=label(selected);
    section.querySelector('.pc-dial > i').style.transform='rotate('+selected*45+'deg)';
    section.querySelectorAll('[data-pc-card]').forEach((card,i)=>{
      let offset = (i - selected + platforms.length) % platforms.length;
      if(offset > platforms.length / 2) offset -= platforms.length;
      card.style.setProperty('--pc-offset',offset);
      card.style.setProperty('--pc-distance',Math.abs(offset));
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
  function wire(section) {
    let deckAnimations=[];
    let revealAnimations=[];
    const stopReveal=()=>{revealAnimations.forEach(a=>a.cancel());revealAnimations=[];};
    const reveal=()=>{
      stopReveal();
      if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      const card=section.querySelector('.pc-selected');
      const animate=(selector,frames,delay,duration)=>{const el=card.querySelector(selector);if(el)revealAnimations.push(el.animate(frames,{duration,delay,easing:'cubic-bezier(.2,.75,.2,1)',fill:'backwards'}));};
      animate('.pc-scenery',[{opacity:.15,transform:'scale(1.13)'},{opacity:1,transform:'scale(1)'}],0,850);
      animate('.pc-card-bottom',[{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}],260,450);
      animate('.pc-card-explore',[{opacity:0,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'}],340,450);
      animate('.pc-reveal-light',[{opacity:0,transform:'translateX(-130%) skewX(-18deg)'},{opacity:.5,offset:.35},{opacity:0,transform:'translateX(180%) skewX(-18deg)'}],100,850);
    };
    const choose = n => {
      const next=(n+platforms.length)%platforms.length;
      if(next===selected)return;
      deckAnimations.forEach(a=>a.cancel());deckAnimations=[];stopReveal();
      const outgoing=section.querySelector('.pc-selected');
      const incoming=section.querySelector(`[data-pc-card="${next}"]`);
      const fromOut=getComputedStyle(outgoing).transform,fromIn=getComputedStyle(incoming).transform;
      let delta=(next-selected+platforms.length)%platforms.length;
      const direction=delta>platforms.length/2?1:-1;
      selected=next;update(section);reveal();
      if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      const endOut=getComputedStyle(outgoing).transform,endIn=getComputedStyle(incoming).transform;
      const endZ=getComputedStyle(outgoing).zIndex;
      deckAnimations.push(outgoing.animate([
        {transform:fromOut,zIndex:9,opacity:1},
        {transform:`translateX(${direction*66}%) translateY(-12px) rotateZ(${direction*13}deg) scale(.94)`,zIndex:9,opacity:1,offset:.42},
        {transform:endOut,zIndex:endZ,opacity:1}
      ],{duration:740,easing:'cubic-bezier(.25,.7,.25,1)'}));
      deckAnimations.push(incoming.animate([
        {transform:fromIn,opacity:.65},
        {transform:'translateY(-17px) scale(1.025)',opacity:1,offset:.62},
        {transform:endIn,opacity:1}
      ],{duration:740,easing:'cubic-bezier(.25,.7,.25,1)'}));
    };
    let start = null, suppressUntil = 0;
    section.addEventListener('click', e=>{
      if(Date.now()<suppressUntil) return;
      const select = e.target.closest('[data-pc-select],[data-pc-card]');
      if(select) choose(Number(select.dataset.pcSelect ?? select.dataset.pcCard));
      const step = e.target.closest('[data-pc-step]');
      if(step) choose(selected + Number(step.dataset.pcStep));
      if(e.target.closest('.pc-explore')) {
        // Reuse the existing platform directory and its admin-maintained links.
        window.pcRequestedPlatform = platforms[selected][0];
        if(typeof go==='function') go('platforms');
      }
    });
    const stage=section.querySelector('.pc-stage');
    stage.addEventListener('keydown',e=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      e.preventDefault();
      choose(e.key==='Home'?0:e.key==='End'?7:selected+(e.key==='ArrowRight'?1:-1));
      stage.focus({preventScroll:true});
    });
    const cards=[...section.querySelectorAll('.pc-card')];
    let dragFrame=0;
    const paintDrag=()=>{
      dragFrame=0;
      if(!start?.dragging)return;
      const {dx,bases,width}=start;
      const progress=Math.min(Math.abs(dx)/width,1);
      const next=(selected+(dx<0?1:-1)+cards.length)%cards.length;
      cards.forEach((card,i)=>{
        if(i===selected){
          card.style.transform=`translateX(${dx}px) rotateZ(${dx/width*12}deg) ${bases[i]}`;
          card.style.zIndex='9';
        }else if(i===next){
          // Bring the next card towards the front continuously as the finger moves.
          const from=new DOMMatrix(bases[i]), to=new DOMMatrix().translate(0,9);
          const a=Array.from(from.toFloat64Array()), b=Array.from(to.toFloat64Array());
          card.style.transform=`matrix3d(${a.map((v,j)=>v+(b[j]-v)*progress).join(',')})`;
          card.style.zIndex='8';
        }else{
          card.style.transform=bases[i];card.style.removeProperty('z-index');
        }
      });
    };
    const finishDrag=(e,cancelled=false)=>{
      if(!start||start.id!==e.pointerId)return;
      const gesture=start;
      if(!gesture.dragging){start=null;return;}
      cancelAnimationFrame(dragFrame);paintDrag();
      const snapshots=cards.map(c=>getComputedStyle(c).transform);
      const velocity=performance.now()-gesture.time<100?gesture.velocity:0;
      const commit=!cancelled&&(Math.abs(gesture.dx)>gesture.width*.24 || (Math.abs(gesture.dx)>12&&Math.abs(velocity)>.45&&velocity*gesture.dx>0));
      const outgoing=selected;
      if(commit)selected=(selected+(gesture.dx<0?1:-1)+cards.length)%cards.length;
      start=null;suppressUntil=Date.now()+400;
      stage.classList.remove('pc-dragging');
      cards.forEach(c=>{c.style.removeProperty('transform');c.style.removeProperty('z-index');});
      update(section,commit);
      if(stage.hasPointerCapture(e.pointerId))stage.releasePointerCapture(e.pointerId);
      if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
        cards.forEach((card,i)=>{
          const end=getComputedStyle(card).transform;
          const frames=[{transform:snapshots[i]},{transform:end}];
          if(commit&&i===outgoing){
            frames[0].zIndex=9;
            frames.splice(1,0,{transform:`translateX(${Math.sign(gesture.dx)*Math.max(Math.abs(gesture.dx),gesture.width*.85)}px) translateY(-6px) rotateZ(${Math.sign(gesture.dx)*15}deg)`,zIndex:9,offset:.35});
            frames[2].zIndex=getComputedStyle(card).zIndex;
          }
          deckAnimations.push(card.animate(frames,{duration:commit?360:260,easing:'cubic-bezier(.2,.8,.2,1)'}));
        });
      }
    };
    stage.addEventListener('pointerdown',e=>{
      if(!e.isPrimary||(e.pointerType==='mouse'&&e.button!==0)||start)return;
      start={x:e.clientX,y:e.clientY,id:e.pointerId,dx:0,lastX:e.clientX,time:performance.now(),velocity:0,dragging:false};
    });
    stage.addEventListener('pointermove',e=>{
      if(!start||start.id!==e.pointerId)return;
      const dx=e.clientX-start.x,dy=e.clientY-start.y;
      if(!start.dragging){
        if(Math.max(Math.abs(dx),Math.abs(dy))<6)return;
        if(Math.abs(dy)>Math.abs(dx)){start=null;return;}
        start.bases=cards.map(c=>getComputedStyle(c).transform);
        start.width=cards[selected].offsetWidth;
        deckAnimations.forEach(a=>a.cancel());deckAnimations=[];stopReveal();
        start.dragging=true;stage.classList.add('pc-dragging');
        stage.setPointerCapture(e.pointerId);
      }
      const now=performance.now(),dt=now-start.time;
      if(dt>0)start.velocity=(e.clientX-start.lastX)/dt;
      start.lastX=e.clientX;start.time=now;start.dx=dx;
      if(!dragFrame)dragFrame=requestAnimationFrame(paintDrag);
    });
    stage.addEventListener('pointerup',e=>finishDrag(e));
    stage.addEventListener('pointercancel',e=>finishDrag(e,true));
    // Touch starts with implicit capture on the inner button. Its loss when
    // capture transfers to the stage is not a cancelled gesture.
    stage.addEventListener('lostpointercapture',e=>{if(e.target===stage)finishDrag(e,true);});
    stage.addEventListener('pointerleave',e=>{if(start&&!start.dragging&&e.pointerType==='mouse')start=null;});
    update(section,false);
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
