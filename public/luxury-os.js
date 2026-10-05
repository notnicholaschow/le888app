// Luxury Gaming OS: presentation layer over the existing demo routes and game logic.
// All balances, member details and mission progress remain demo data.
const osScenes = [
  {
    color: "246,172,65",
    secondary: "139,80,31",
    label: "THE GOLDEN HOUR",
    category: "WHEEL / MULTIPLIER",
  },
  {
    color: "255,134,54",
    secondary: "184,66,109",
    label: "FOLLOW THE MOMENTUM",
    category: "DROP / MULTIPLIER",
  },
  {
    color: "221,174,95",
    secondary: "129,77,177",
    label: "TURN YOUR LUCK",
    category: "CARDS / REVEAL",
  },
  {
    color: "223,176,81",
    secondary: "74,108,146",
    label: "UNLOCK THE UNKNOWN",
    category: "VAULT / DISCOVERY",
  },
  { color: "240,186,80", secondary: "150,90,30", label: "CROSS THE GOLDEN STREET", category: "ROAD / CASH OUT" },
  { color: "255,110,90", secondary: "150,40,60", label: "FOUR JACKPOTS, ONE PICK", category: "PICK / JACKPOT" },
];
function osSetScene() {
  const g = games[state.game],
    scene = osScenes[state.game] || osScenes[0];
  document.body.style.setProperty("--os-accent", scene.color);
  document.body.style.setProperty("--os-secondary", scene.secondary);
  document.body.style.setProperty("--os-art", `url("assets/${g.asset}.png")`);
  document.body.dataset.osScene = g.id;
}
function osStage() {
  return `<section class="os-stage-shell" aria-label="Interactive game selector"><div class="os-stage-topline"><span><i></i> ${osScenes[state.game].label}</span><button data-go="games">ALL GAMES ${icon("rtp")}</button></div><div class="os-stage" tabindex="0" aria-label="Game stage. Swipe or use left and right arrow keys"><div class="os-orbit" aria-hidden="true"></div><div class="os-stage-axis" aria-hidden="true"></div>${games.map((g, i) => `<button class="os-game-card${g.soon?" soon":""}" data-os-index="${i}" aria-label="Select ${g.name}"><img src="assets/${g.asset}.png" alt="" draggable="false">${g.soon?'<span class="soon-badge">SOON</span>':''}<span class="os-card-corner">0${i + 1} / LE888</span><span class="os-card-info"><small>${osScenes[i].category}</small><b>${g.name}</b><span>${g.sub}</span></span></button>`).join("")}</div><div class="os-selector"><button class="os-step" data-os-step="-1" aria-label="Previous game">${icon("back")}</button><div class="os-dial" role="slider" tabindex="0" aria-label="Rotary game selector" aria-valuemin="1" aria-valuemax="${games.length}" aria-valuenow="${state.game + 1}"><div class="os-dial-ticks"></div><span class="os-dial-index">0${state.game + 1}</span></div><div class="os-selector-copy"><small>SELECT YOUR EXPERIENCE</small><div class="os-selector-dots">${games.map((g, i) => `<button data-os-select="${i}" aria-label="Select ${g.name}"></button>`).join("")}</div></div><button class="os-step os-step-next" data-os-step="1" aria-label="Next game">${icon("back")}</button></div><button class="os-launch" id="os-play"><span>PLAY NOW</span><span aria-hidden="true">↗</span></button></section>`;
}
home = function () {
  return `<section class="os-player-strip"><button id="os-player" aria-label="Open your profile"><span class="os-avatar">${icon("user")}</span><span><small>WELCOME BACK</small><b>${memberName()}</b></span><span class="os-vip">${icon("crown")} ${(window.memberData&&memberData.vip&&memberData.vip.rank_name)?String(memberData.vip.rank_name).toUpperCase():"MEMBER"}</span></button><button id="os-notifications" aria-label="Open notifications" class="os-notifications">${icon("chat")}<i>${state.notificationsCleared ? "0" : "3"}</i></button></section><section class="os-points" aria-label="Available Points"><div class="os-micro-label">YOUR NEXT MOVE STARTS HERE</div><div class="os-points-number"><strong>${memberPoints()}</strong><span>PTS</span><button data-go="deposit" aria-label="Add points">+</button></div><div class="os-credit-line"><span>DEPOSIT <b>—</b></span><i></i><span>FREE CREDIT <b>—</b></span></div></section>${osStage()}<nav class="os-action-dock" aria-label="Quick actions">${[
    ["deposit", "Deposit", "deposit"],
    ["withdraw", "Withdraw", "withdraw"],
    ["gift", "Rewards", "rewards"],
    ["crown", "VIP Club", "vip"],
  ]
    .map(
      ([i, l, p]) =>
        `<button data-go="${p}">${icon(i)}<span>${l}</span></button>`,
    )
    .join(
      "",
    )}</nav><section class="os-live-missions"><div class="os-section-heading"><div><small>KEEP YOUR MOMENTUM</small><h2>Daily missions<span> / 04</span></h2></div><button data-go="missions" aria-label="View all missions">↗</button></div><button class="os-streak" data-go="rewards">${icon("spark")}<span><b>3 day streak</b><small>Your next check-in is waiting</small></span><strong>+5 <small>PTS</small></strong><span>›</span></button><div class="os-mission-pair">${missions
    .slice(0, 2)
    .map(
      ([i, t, n, max, pts]) =>
        `<button data-go="missions"><span>${icon(i)}<small>${n} / ${max}</small></span><b>${t}</b><div class="progress"><i style="width:${(n / max) * 100}%"></i></div><strong>+${pts} PTS</strong></button>`,
    )
    .join(
      "",
    )}</div></section><section class="os-offers"><div class="os-section-heading"><div><small>THE EXTRA ADVANTAGE</small><h2>Member privileges</h2></div><button data-go="promotions" aria-label="View promotions">↗</button></div>${promotionCarousel()}</section><div class="os-signature"><span>LE888</span><small>PLAY MORE TOGETHER</small></div>`;
};
function osUpdateStage() {
  osSetScene();
  const count = games.length;
  document.querySelectorAll(".os-game-card").forEach((card, i) => {
    let d = (i - state.game + count) % count;
    if (d > count / 2) d -= count;
    card.style.setProperty("--offset", d);
    card.style.setProperty("--depth", Math.abs(d));
    card.classList.toggle("os-selected", d === 0);
    card.classList.toggle("os-card-hidden", Math.abs(d) > 1);
    card.tabIndex = Math.abs(d) > 1 ? -1 : 0;
    card.setAttribute("aria-pressed", String(d === 0));
    card.setAttribute(
      "aria-label",
      (d === 0 ? "Play " : "Select ") + games[i].name,
    );
  });
  document.querySelectorAll("[data-os-select]").forEach((b, i) => {
    b.classList.toggle("active", i === state.game);
    b.setAttribute("aria-pressed", String(i === state.game));
  });
  const dial = document.querySelector(".os-dial-ticks");
  if (dial) dial.style.transform = `rotate(${state.game * 90}deg)`;
  const knob = document.querySelector(".os-dial");
  if (knob) {
    knob.setAttribute("aria-valuenow", String(state.game + 1));
    knob.setAttribute("aria-valuetext", games[state.game].name);
  }
  const number = document.querySelector(".os-dial-index");
  if (number) number.textContent = "0" + (state.game + 1);
  const label = document.querySelector(".os-stage-topline>span");
  if (label) label.innerHTML = "<i></i> " + osScenes[state.game].label;
  const launch = document.querySelector("#os-play");
  if (launch)
    launch.setAttribute("aria-label", "Play " + games[state.game].name);
}
function osSelect(n) {
  state.game = (n + games.length) % games.length;
  osUpdateStage();
}
function wireOsHome() {
  const stage = document.querySelector(".os-stage");
  if (!stage) return;
  document.querySelector("#os-player").onclick = quickProfile;
  document.querySelector("#os-notifications").onclick = notifications;
  document.querySelector("#os-play").onclick = () => go("games");
  document.querySelectorAll("[data-os-index]").forEach(
    (b) =>
      (b.onclick = () => { go("games"); }),
  );
  document
    .querySelectorAll("[data-os-step]")
    .forEach(
      (b) =>
        (b.onclick = () => osSelect(state.game + Number(b.dataset.osStep))),
    );
  document
    .querySelectorAll("[data-os-select]")
    .forEach((b) => (b.onclick = () => osSelect(Number(b.dataset.osSelect))));
  stage.onkeydown = (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      osSelect(state.game + (e.key === "ArrowRight" ? 1 : -1));
    }
  };
  let down = false,
    drag = false,
    x = 0,
    y = 0,
    suppress = false;
  stage.onpointerdown = (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    down = true;
    drag = false;
    x = e.clientX;
    y = e.clientY;
  };
  stage.onpointermove = (e) => {
    if (!down) return;
    const dx = e.clientX - x,
      dy = e.clientY - y;
    if (!drag && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
      down = false;
      return;
    }
    if (!drag && Math.abs(dx) > 8) {
      drag = true;
      suppress = true;
      stage.setPointerCapture(e.pointerId);
    }
    if (drag) {
      e.preventDefault();
      stage.style.setProperty(
        "--drag",
        Math.max(-35, Math.min(35, dx * 0.18)) + "px",
      );
    }
  };
  function finish(e, cancel) {
    if (!down) return;
    down = false;
    stage.style.setProperty("--drag", "0px");
    if (drag) {
      if (!cancel && Math.abs(e.clientX - x) > 35)
        osSelect(state.game + (e.clientX < x ? 1 : -1));
      if (stage.hasPointerCapture(e.pointerId))
        stage.releasePointerCapture(e.pointerId);
      setTimeout(() => (suppress = false), 0);
    }
    drag = false;
  }
  stage.onpointerup = (e) => finish(e, false);
  stage.onpointercancel = (e) => finish(e, true);
  stage.addEventListener(
    "click",
    (e) => {
      if (suppress) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  const knob = document.querySelector(".os-dial");
  let knobStart = 0,
    knobDelta = 0,
    knobDown = false;
  const pointerAngle = (e) => {
    const r = knob.getBoundingClientRect();
    return (
      (Math.atan2(
        e.clientY - r.y - r.height / 2,
        e.clientX - r.x - r.width / 2,
      ) *
        180) /
      Math.PI
    );
  };
  knob.onpointerdown = (e) => {
    if (e.button !== 0) return;
    knobDown = true;
    knobDelta = 0;
    knobStart = pointerAngle(e);
    knob.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  knob.onpointermove = (e) => {
    if (!knobDown) return;
    knobDelta = pointerAngle(e) - knobStart;
    if (knobDelta > 180) knobDelta -= 360;
    if (knobDelta < -180) knobDelta += 360;
    knob.querySelector(".os-dial-ticks").style.transform =
      `rotate(${state.game * 90 + knobDelta}deg)`;
  };
  const finishKnob = (e) => {
    if (!knobDown) return;
    knobDown = false;
    osSelect(
      state.game + (Math.abs(knobDelta) > 20 ? (knobDelta > 0 ? 1 : -1) : 0),
    );
    if (knob.hasPointerCapture(e.pointerId))
      knob.releasePointerCapture(e.pointerId);
  };
  knob.onpointerup = finishKnob;
  knob.onpointercancel = (e) => {
    knobDelta = 0;
    finishKnob(e);
  };
  knob.onkeydown = (e) => {
    if (
      [
        "ArrowLeft",
        "ArrowDown",
        "ArrowRight",
        "ArrowUp",
        "Home",
        "End",
      ].includes(e.key)
    ) {
      e.preventDefault();
      osSelect(
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? games.length - 1
            : state.game + (["ArrowRight", "ArrowUp"].includes(e.key) ? 1 : -1),
      );
    }
  };
  osUpdateStage();
}
const osPreviousSelect = select;
select = function (n) {
  osPreviousSelect(n);
  osSetScene();
};
const osPreviousMenu = menu;
menu = function () {
  osPreviousMenu();
  side.classList.add("os-command-center");
  const top = side.querySelector(".drawer-top");
  const label = document.createElement("div");
  label.className = "os-command-label";
  label.innerHTML = "<small>YOUR PERSONAL SPACE</small><h2>Command Center</h2>";
  top.querySelector(".brand-lockup").replaceWith(label);
  side.querySelector(".drawer-footer").innerHTML =
    "<b>LE888</b><span>PLAY MORE TOGETHER</span>";
  side
    .querySelectorAll(".drawer-section")
    .forEach((el, i) => el.style.setProperty("--panel-index", i));
};
const osPreviousRender = render;
render = function () {
  document.body.classList.add("luxury-os");
  document.body.dataset.osPage = state.page;
  osPreviousRender();
  if (state.page === "home") {
    header.classList.remove("home-compact-header");
    header.classList.add("os-home-header");
    header.innerHTML = `<button class="icon-btn" id="os-menu" aria-label="Open Command Center" aria-controls="side-menu" aria-expanded="false">${icon("menu")}</button><button class="header-home-logo" aria-label="LE888 — Return to Home"><img class="brand-img" src="/assets/logo888.webp" alt="LE888"></button><button class="icon-btn" id="os-chat" aria-label="Live Chat">${icon("chat")}<i class="chat-dot"></i></button>`;
    header.querySelector("#os-menu").onclick = menu;
    header.querySelector("#os-chat").onclick = () => go("chat");
    header.querySelector(".header-home-logo").onclick = () => go("home");
    screen.classList.add("os-lobby");
    wireOsHome();
  } else {
    header.classList.remove("os-home-header");
  }
  osSetScene();
};
render();
