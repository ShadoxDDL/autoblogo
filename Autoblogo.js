(async () => {
  "use strict";

  if (window.__autoblogoSILoading || window.__autoblogoSIRegistered) return;
  window.__autoblogoSILoading = true;

  const apiDeadline = Date.now() + 120000;
  let G;
  while (Date.now() < apiDeadline) {
    const candidate = window.Gargonem;
    if (
      candidate?.Addons?.New?.registerID &&
      candidate?.Addons?.New?.register &&
      candidate?.Addons?.New?.registerStartupAndShutdown &&
      candidate?.UI?.Components &&
      candidate?.UI?.React
    ) {
      G = candidate;
      break;
    }
    await new Promise(resolve => window.setTimeout(resolve, 250));
  }
  if (!G) throw new Error("Nie znaleziono API dodatk\u00f3w Gargonem.");

  const Addons = G.Addons;
  const UI = G.UI.Components;
  const React = G.UI.React;
  const managerStorage = G.Addons.managerStorage;
  const Util = G.Util;

  const ADDON_ID = Addons.New.registerID("autoblogoSI");
  const CHECK_MS = 250;
  const RETRY_MS = 250;
  const EQUIP_COOLDOWN_MS = 60000;

  const storage = new Addons.Storage("autoblogo-si", {
    enabled: false,
    itemName: "",
    itemKey: "",
    lastEquipAt: 0,
    legacyMigrated: false
  }, true);

  if (!storage.get("legacyMigrated")) {
    try {
      const legacy = JSON.parse(localStorage.getItem("codex_auto_blogo_v1") || "{}");
      if (typeof legacy.enabled === "boolean") storage.set("enabled", legacy.enabled);
      if (legacy.itemName) storage.set("itemName", String(legacy.itemName));
      if (legacy.itemKey) storage.set("itemKey", String(legacy.itemKey));
      if (Number.isFinite(Number(legacy.lastEquipAt))) storage.set("lastEquipAt", Number(legacy.lastEquipAt));
    } catch {}
    storage.set("legacyMigrated", true);
  }

  const RARITIES = {
    0: { name: "Pospolity", color: "#9da1a7" },
    1: { name: "Unikatowy", color: "#338742" },
    2: { name: "Heroiczny", color: "#38b8eb" },
    3: { name: "Legendarny", color: "#ff8400" },
    4: { name: "Ulepszony", color: "#9fac28" },
    5: { name: "Artefakt", color: "#e53935" }
  };

  let lastTry = 0;
  let previousBlessed = null;
  let previousBattle = false;
  let runtimeActive = false;
  let tickTimer = null;
  let battleObserver = null;
  let apiHookInstalled = false;
  let currentStatus = "Oczekiwanie na dane gry...";
  let currentStatusColor = "#ddd";
  let selectedMissingSince = null;
  const statusListeners = new Set();

  function setStatus(text, color = "#ddd") {
    currentStatus = text;
    currentStatusColor = color;
    for (const listener of statusListeners) listener(text, color);
  }

  function parseStats(item) {
    const parsed = String(item?.stat || "").split(";").reduce((out, part) => {
      const [key, value] = part.split("=");
      if (key) out[key] = value ?? true;
      return out;
    }, {});
    return item?._cachedStats && typeof item._cachedStats === "object"
      ? { ...parsed, ...item._cachedStats }
      : parsed;
  }

  function rarityId(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const text = String(value || "").toLowerCase();
    if (/artef|artifact/.test(text)) return 5;
    if (/ulepsz|upgraded/.test(text)) return 4;
    if (/legend/.test(text)) return 3;
    if (/hero/.test(text)) return 2;
    if (/unik|unique/.test(text)) return 1;
    return 0;
  }

  function detectRarity(item, stats) {
    let text = [
      item.rarity,
      item.d?.rarity,
      stats.rarity,
      item.$?.[0]?.className,
      item.element?.className
    ].filter(value => value != null).join(" ").toLowerCase();

    const tip = String(item.tip ?? item.d?.tip ?? item.tooltip ?? item._tip ?? "");
    const structuredRank = tip.match(/(?:item-(?:type|rarity)|rarity)[^>]*>\s*(?:<[^>]+>\s*)*(pospolity|unikatowy|heroiczny|legendarny|ulepszony|artefakt)/i)?.[1];
    const plainTip = tip.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (structuredRank) text += ` ${structuredRank.toLowerCase()}`;
    else if (/^(pospolity|unikatowy|heroiczny|legendarny|ulepszony|artefakt)$/i.test(plainTip)) {
      text += ` ${plainTip.toLowerCase()}`;
    }

    if (/artef|artifact/.test(text)) return 5;
    if (/ulepsz|upgraded/.test(text)) return 4;
    if (/legend/.test(text)) return 3;
    if (/hero/.test(text)) return 2;
    if (/unik|unique/.test(text)) return 1;
    if (/pospol|common/.test(text)) return 0;
    return rarityId(stats.rarity ?? item.rarity ?? item.d?.rarity ?? item.pr ?? item.d?.pr ?? stats.pr ?? 0);
  }

  function bagItems() {
    const items = window.Engine?.items;
    if (items) {
      if (typeof items.fetchLocationItems === "function") return items.fetchLocationItems("g") || [];
      const views = items.getViews?.("bag") || {};
      return Object.keys(views).map(id => items.getItemById?.(id)).filter(Boolean);
    }

    const oldItems = window.g?.item;
    if (!oldItems) return [];
    return Object.entries(oldItems)
      .filter(([, item]) => !item.loc || item.loc === "g")
      .map(([id, item]) => ({ ...item, id: item.id ?? id }));
  }

  function heroData() {
    return window.Engine?.hero?.d || window.hero || null;
  }

  function gameReady() {
    return Boolean(
      (window.Engine?.hero?.d && window.Engine?.items) ||
      (window.hero && window.g?.item)
    );
  }

  function heroIsDead() {
    return Boolean(window.Engine?.dead || window.hero?.dead);
  }

  function isInBattle() {
    const oldBattleWindow = document.getElementById("battle");
    if (oldBattleWindow) {
      const style = getComputedStyle(oldBattleWindow);
      const rect = oldBattleWindow.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }

    const battle = window.Engine?.battle;
    try {
      if (typeof battle?.isBattleActive === "function" && battle.isBattleActive()) return true;
      if (typeof battle?.isActive === "function" && battle.isActive()) return true;
    } catch {}

    if (battle?.d || battle?.battleData || battle?.data?.fighters) return true;
    if (window.g?.battle === true || Number(window.g?.battle) === 1 || window.battle?.active === true) return true;

    const battleWindow = document.querySelector("#battle-window, .battle-window");
    if (!battleWindow) return false;
    const style = getComputedStyle(battleWindow);
    const rect = battleWindow.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function blessingIsActive() {
    const hero = heroData();
    if (Number(hero?.is_blessed) === 1) return true;

    const oldItems = window.g?.item;
    if (!oldItems) return false;
    return Object.values(oldItems).some(item =>
      Number(item?.cl) === 25 && ["b", "bless", "blessing"].includes(String(item?.loc || "").toLowerCase())
    );
  }

  function blessings() {
    const seenIds = new Set();
    return bagItems()
      .filter(item => Number(item.cl ?? item.d?.cl) === 25)
      .map(item => {
        const stats = parseStats(item);
        const id = String(item.id ?? item.d?.id ?? "");
        const rarityNumber = detectRarity(item, stats);
        const rarity = RARITIES[rarityNumber] || RARITIES[0];
        const rawAmount = item.amount ?? item.d?.amount ?? item.quantity ?? item.d?.quantity ??
          item.count ?? item.d?.count ?? stats.amount ?? stats.quantity ?? stats.count ?? stats.stack ?? 1;
        const parsedAmount = Number.parseInt(rawAmount, 10);
        const name = String(item.name ?? item.d?.name ?? "B\u0142ogos\u0142awie\u0144stwo");
        return {
          id,
          name,
          ttl: Number(stats.ttl || 0),
          amount: Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 1,
          rarityId: rarityNumber,
          rarity,
          key: `${name}\u0000${rarityNumber}`
        };
      })
      .filter(entry => entry.id && entry.ttl > 0)
      .filter(entry => {
        if (seenIds.has(entry.id)) return false;
        seenIds.add(entry.id);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name, "pl"));
  }

  function uniqueBlessings() {
    const grouped = new Map();
    for (const entry of blessings()) {
      const old = grouped.get(entry.key);
      if (!old) grouped.set(entry.key, { ...entry });
      else old.amount += entry.amount;
    }
    return [...grouped.values()];
  }

  function ensureSelectedBlessing(list) {
    const storedKey = storage.get("itemKey");
    const storedName = storage.get("itemName");
    if (!storedKey && !storedName) {
      selectedMissingSince = null;
      return false;
    }

    const selected = list.find(entry => storedKey ? entry.key === storedKey : entry.name === storedName);
    if (selected) {
      selectedMissingSince = null;
      if (storedKey !== selected.key) storage.set("itemKey", selected.key);
      if (storedName !== selected.name) storage.set("itemName", selected.name);
      return false;
    }

    if (!gameReady()) return false;
    if (selectedMissingSince === null) {
      selectedMissingSince = Date.now();
      return false;
    }
    if (Date.now() - selectedMissingSince < 2000) return false;

    storage.set("itemKey", "");
    storage.set("itemName", "");
    selectedMissingSince = null;
    setStatus("Wybrane b\u0142ogos\u0142awie\u0144stwo wygas\u0142o lub zosta\u0142o usuni\u0119te. Wybierz nowe myszk\u0105.", "#ef5350");
    return true;
  }

  function tick() {
    if (!runtimeActive || !gameReady()) return;
    const hero = heroData();
    if (!storage.get("enabled") || (!storage.get("itemKey") && !storage.get("itemName")) || !hero || heroIsDead()) return;

    const blessedNow = blessingIsActive();
    if (blessedNow) {
      if (previousBlessed === false) storage.set("lastEquipAt", Date.now());
      previousBlessed = true;
      setStatus("B\u0142ogos\u0142awie\u0144stwo jest aktywne", "#81c784");
      return;
    }
    previousBlessed = false;

    if (isInBattle()) {
      previousBattle = true;
      setStatus("Oczekiwanie na zako\u0144czenie walki...", "#ffb74d");
      return;
    }
    previousBattle = false;

    const lastEquipAt = Number(storage.get("lastEquipAt") || 0);
    if (Date.now() - lastEquipAt < EQUIP_COOLDOWN_MS || Date.now() - lastTry < RETRY_MS) return;

    const candidate = blessings()
      .filter(x => storage.get("itemKey") ? x.key === storage.get("itemKey") : x.name === storage.get("itemName"))
      .sort((a, b) => a.ttl - b.ttl)[0];

    if (!candidate) {
      setStatus("Wybranego b\u0142ogos\u0142awie\u0144stwa nie ma w torbach", "#ffb74d");
      return;
    }
    if (typeof window._g !== "function") return;

    lastTry = Date.now();
    setStatus(`U\u017cywam: ${candidate.name}`, "#ffd36a");
    window._g(`moveitem&st=1&id=${encodeURIComponent(candidate.id)}`);
  }

  function afterBattle() {
    if (!runtimeActive) return;
    previousBattle = false;
    window.setTimeout(tick, 0);
    window.setTimeout(tick, 50);
    window.setTimeout(tick, 150);
  }

  function installBattleEndHook() {
    if (!apiHookInstalled) {
      try {
        if (typeof window.API?.addCallbackToEvent === "function") {
          window.API.addCallbackToEvent("close_battle", afterBattle);
          apiHookInstalled = true;
        }
      } catch {}
    }

    battleObserver?.disconnect();
    const oldBattleWindow = document.getElementById("battle");
    if (!oldBattleWindow) return;
    let wasVisible = isInBattle();
    battleObserver = new MutationObserver(() => {
      const visible = isInBattle();
      if (wasVisible && !visible) afterBattle();
      wasVisible = visible;
    });
    battleObserver.observe(oldBattleWindow, {
      attributes: true,
      attributeFilter: ["style", "class"]
    });
  }

  class AutoblogoWindow extends React.Component {
    constructor(props) {
      super(props);
      this.mappedKeys = ["enabled", "itemKey", "itemName"];
      this.globalMappedKeys = ["autoblogoSIWindowEnabled"];
      this.state = {
        blessings: uniqueBlessings(),
        status: currentStatus,
        statusColor: currentStatusColor
      };
      storage.bind(this, this.mappedKeys);
      managerStorage.bind(this, this.globalMappedKeys);
      this.onStatus = (status, statusColor) => this.setState({ status, statusColor });
      this.pointerSelectionArmed = false;
      this.refresh = this.refresh.bind(this);
    }

    componentDidMount() {
      statusListeners.add(this.onStatus);
      this.refreshTimer = window.setInterval(this.refresh, 500);
      this.refresh();
    }

    componentWillUnmount() {
      storage.unbind(this, this.mappedKeys);
      managerStorage.unbind(this, this.globalMappedKeys);
      statusListeners.delete(this.onStatus);
      window.clearInterval(this.refreshTimer);
    }

    refresh() {
      const list = uniqueBlessings();
      const selectionCleared = ensureSelectedBlessing(list);
      const signature = JSON.stringify(list.map(x => [x.key, x.amount]));
      if (signature !== this.lastSignature) {
        this.lastSignature = signature;
        this.setState({ blessings: list });
      }
      if (!list.length && !selectionCleared && !storage.get("itemKey") && !storage.get("itemName")) {
        setStatus("Nie znaleziono b\u0142ogos\u0142awie\u0144stw", "#ffb74d");
      }
    }

    render() {
      const list = this.state.blessings || [];
      const options = [
        {
          label: list.length ? "Wybierz b\u0142ogos\u0142awie\u0144stwo myszk\u0105" : "Brak b\u0142ogos\u0142awie\u0144stw w torbach",
          value: ""
        },
        ...list.map(entry => ({
            label: `${entry.name} \u00d7${entry.amount} (${entry.rarity.name})`,
            value: entry.key
          }))
      ];

      return React.createElement(UI.NamedWindow, {
        name: "autoblogo-si",
        title: "Autoblogo",
        visible: this.state.autoblogoSIWindowEnabled ?? true,
        onClose: () => managerStorage.toggle("autoblogoSIWindowEnabled")
      },
        React.createElement(UI.WithLabelReverse, { label: "W\u0142\u0105cz automatyczne u\u017cywanie" },
          React.createElement(UI.CheckboxPersistent, { storage, bind: "enabled" })
        ),
        React.createElement(UI.WithLabel, { label: "B\u0142ogos\u0142awie\u0144stwo" },
          React.createElement("div", {
            onPointerDownCapture: () => {
              this.pointerSelectionArmed = true;
            },
            onKeyDownCapture: event => {
              this.pointerSelectionArmed = false;
              if (event.key !== "Tab" && event.key !== "Escape") event.preventDefault();
              event.stopPropagation();
            },
            onKeyPressCapture: event => {
              event.preventDefault();
              event.stopPropagation();
            },
            onKeyUpCapture: event => {
              if (event.key !== "Tab" && event.key !== "Escape") event.preventDefault();
              event.stopPropagation();
            }
          },
            React.createElement(UI.Select, {
              style: { width: 210 },
              options,
              selected: this.state.itemKey || "",
              onChange: value => {
                if (!this.pointerSelectionArmed) return;
                this.pointerSelectionArmed = false;
                const selected = list.find(entry => entry.key === value);
                storage.set("itemKey", selected ? value : "");
                storage.set("itemName", selected?.name || "");
                selectedMissingSince = null;
                if (selected) setStatus(`Wybrano: ${selected.name}`, selected.rarity.color);
              }
            })
          )
        ),
        React.createElement("div", {
          style: {
            marginTop: 6,
            textAlign: "center",
            color: this.state.statusColor || "#ddd"
          }
        }, this.state.status || "")
      );
    }
  }

  function startup() {
    runtimeActive = true;
    lastTry = 0;
    previousBlessed = null;
    previousBattle = false;
    selectedMissingSince = null;
    installBattleEndHook();
    tick();
    tickTimer = window.setInterval(tick, CHECK_MS);
  }

  function shutdown() {
    runtimeActive = false;
    window.clearInterval(tickTimer);
    tickTimer = null;
    battleObserver?.disconnect();
    battleObserver = null;
  }

  Addons.New.register({
    id: ADDON_ID,
    name: "Autoblogo",
    descriptionBrief: "Automatycznie zak\u0142ada wybrane b\u0142ogos\u0142awie\u0144stwo.",
    descriptionFull: "Wykrywa wyga\u015bni\u0119cie b\u0142ogos\u0142awie\u0144stwa i zak\u0142ada wybrany egzemplarz po zako\u0144czeniu walki.",
    enabledByDefault: true,
    window: AutoblogoWindow
  });
  Addons.New.registerStartupAndShutdown(ADDON_ID, startup, shutdown);
  window.__autoblogoSIRegistered = true;
  window.__autoblogoSILoading = false;
})().catch(error => {
  window.__autoblogoSILoading = false;
  console.error("[Autoblogo SI]", error);
});
