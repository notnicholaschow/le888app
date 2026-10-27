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
    return `<section class="pc-collection pc-deck pc-flow" aria-labelledby="pc-title">
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
  // Same feel as the Mini Games carousel: one swipe = one card, and the browser's own
  // CSS animation does the sliding (steady speed, no lag). Loops 8 -> 1 -> 2 forever.
  function wire(section) {
    const stage=section.querySelector('.pc-stage');
    const cards=[...section.querySelectorAll('.pc-card')];
    const N=cards.length;
    const reduce=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
    let revealAnimations=[];
    const stopReveal=()=>{revealAnimations.forEach(a=>a.cancel());revealAnimations=[];};
    const reveal=()=>{
      stopReveal();
      if(reduce())return;
      const card=section.querySelector('.pc-selected');if(!card)return;
      const animate=(selector,frames,delay,duration)=>{const el=card.querySelector(selector);if(el)revealAnimations.push(el.animate(frames,{duration,delay,easing:'cubic-bezier(.2,.75,.2,1)',fill:'backwards'}));};
      animate('.pc-card-bottom',[{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],180,380);
      animate('.pc-card-explore',[{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}],240,380);
      animate('.pc-reveal-light',[{opacity:0,transform:'translateX(-130%) skewX(-18deg)'},{opacity:.5,offset:.35},{opacity:0,transform:'translateX(180%) skewX(-18deg)'}],160,800);
    };
    function layout(){
      cards.forEach((c,i)=>{
        let d=(i-selected+N)%N; if(d>N/2)d-=N;
        c.style.setProperty('--pc-offset',d);
        c.style.setProperty('--pc-distance',Math.abs(d));
        c.classList.toggle('pc-hidden',Math.abs(d)>1);
      });
    }
    function select(n){
      n=((n%N)+N)%N;
      if(n===selected)return;
      selected=n; layout(); update(section); reveal();
    }
    section.addEventListener('click',e=>{
      if(e.target.closest('.pc-explore')){
        // Reuse the existing platform directory and its admin-maintained links.
        window.pcRequestedPlatform=platforms[selected][0];
        if(typeof go==='function')go('platforms');
        return;
      }
      const step=e.target.closest('[data-pc-step]');
      if(step){select(selected+Number(step.dataset.pcStep));return;}
      const sel=e.target.closest('[data-pc-select],[data-pc-card]');
      if(sel)select(Number(sel.dataset.pcSelect ?? sel.dataset.pcCard));
    });
    stage.addEventListener('keydown',e=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
      e.preventDefault();
      if(e.key==='Home')select(0);else if(e.key==='End')select(N-1);else select(selected+(e.key==='ArrowRight'?1:-1));
      stage.focus({preventScroll:true});
    });
    // Swipe: the cards lean a little with the finger; letting go after 35px moves one card.
    let down=false,drag=false,x=0,y=0,suppress=false;
    stage.addEventListener('pointerdown',e=>{
      if(!e.isPrimary||(e.pointerType==='mouse'&&e.button!==0))return;
      down=true;drag=false;x=e.clientX;y=e.clientY;
    });
    stage.addEventListener('pointermove',e=>{
      if(!down)return;
      const dx=e.clientX-x,dy=e.clientY-y;
      if(!drag&&Math.abs(dy)>12&&Math.abs(dy)>Math.abs(dx)){down=false;return;} // page scroll
      if(!drag&&Math.abs(dx)>8){drag=true;suppress=true;try{stage.setPointerCapture(e.pointerId);}catch(err){}}
      if(drag){e.preventDefault();stage.style.setProperty('--pc-drag',Math.max(-35,Math.min(35,dx*.18))+'px');}
    });
    const finish=(e,cancel)=>{
      if(!down)return;
      down=false;
      stage.style.setProperty('--pc-drag','0px');
      if(drag){
        if(!cancel&&Math.abs(e.clientX-x)>35)select(selected+(e.clientX<x?1:-1));
        try{if(stage.hasPointerCapture(e.pointerId))stage.releasePointerCapture(e.pointerId);}catch(err){}
        setTimeout(()=>{suppress=false;},0);
      }
      drag=false;
    };
    stage.addEventListener('pointerup',e=>finish(e,false));
    stage.addEventListener('pointercancel',e=>finish(e,true));
    stage.addEventListener('click',e=>{if(suppress){e.preventDefault();e.stopImmediatePropagation();}},true);
    layout();
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
