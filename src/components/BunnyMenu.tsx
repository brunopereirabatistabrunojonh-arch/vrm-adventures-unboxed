import { useEffect, useState } from "react";
import bunnyGirl from "@/assets/bunny-girl.png";
import galaxiaAsset from "@/assets/galaxia.vrm.asset.json";

type Screen = "main" | "shop" | "settings" | "ranking" | "exit";

type Skin = {
  id: string;
  name: string;
  price: number;
  color: string;
  // When set, equipping this skin swaps the 3D player model to this URL
  // (keeps the same Mixamo animations if the model has a VRM humanoid rig).
  modelUrl?: string;
};
const SKINS: Skin[] = [
  { id: "classic", name: "Bunny Classic", price: 0, color: "#111" },
  { id: "galaxia", name: "Galáxia Anime Girl", price: 300, color: "#8b5cf6", modelUrl: galaxiaAsset.url },
  { id: "rose", name: "Rose Gold", price: 100, color: "#f9a8d4" },
  { id: "neon", name: "Neon Cyber", price: 250, color: "#22d3ee" },
  { id: "royal", name: "Royal Purple", price: 500, color: "#a855f7" },
  { id: "ember", name: "Ember", price: 750, color: "#f97316" },
];

const LS_CHARACTER_URL = "bunny.characterUrl";
function applyCharacterSkin(id: string) {
  const s = SKINS.find((x) => x.id === id);
  const url = s?.modelUrl ?? "";
  try {
    if (url) localStorage.setItem(LS_CHARACTER_URL, url);
    else localStorage.removeItem(LS_CHARACTER_URL);
  } catch {
    /* noop */
  }
  try {
    window.dispatchEvent(new CustomEvent("bunny:character", { detail: { url } }));
  } catch {
    /* noop */
  }
}

const LS = {
  best: "bunny.bestKills",
  coins: "bunny.coins",
  owned: "bunny.owned",
  skin: "bunny.skin",
  settings: "bunny.settings",
  ranking: "bunny.ranking",
};

function readJSON<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* noop */
  }
}

export type BunnySettings = {
  volume: number;
  sfx: number;
  sensitivity: number;
  quality: "low" | "medium" | "high";
};

const DEFAULT_SETTINGS: BunnySettings = {
  volume: 70,
  sfx: 80,
  sensitivity: 50,
  quality: "high",
};

export function loadSettings(): BunnySettings {
  return { ...DEFAULT_SETTINGS, ...readJSON<Partial<BunnySettings>>(LS.settings, {}) };
}

type Props = {
  open: boolean;
  currentKills: number;
  onPlay: () => void;
};

export default function BunnyMenu({ open, currentKills, onPlay }: Props) {
  const [screen, setScreen] = useState<Screen>("main");
  const [best, setBest] = useState<number>(() => readJSON(LS.best, 0));
  const [coins, setCoins] = useState<number>(() => readJSON(LS.coins, 0));
  const [owned, setOwned] = useState<string[]>(() => readJSON(LS.owned, ["classic"]));
  const [skin, setSkin] = useState<string>(() => readJSON(LS.skin, "classic"));
  const [settings, setSettings] = useState<BunnySettings>(() => loadSettings());
  const [ranking, setRanking] = useState<{ name: string; kills: number; date: string }[]>(() =>
    readJSON(LS.ranking, [] as { name: string; kills: number; date: string }[])
  );

  // Reset to main whenever menu opens
  useEffect(() => {
    if (open) setScreen("main");
  }, [open]);

  // Record best + earn coins whenever kills go up
  useEffect(() => {
    setBest((b) => {
      const nb = Math.max(b, currentKills);
      if (nb !== b) writeJSON(LS.best, nb);
      return nb;
    });
    setCoins((c) => {
      const nc = Math.max(c, readJSON(LS.coins, 0) + 0); // stable read
      return nc;
    });
  }, [currentKills]);

  // Persist settings
  useEffect(() => {
    writeJSON(LS.settings, settings);
    (window as unknown as { __bunnySettings?: BunnySettings }).__bunnySettings = settings;
  }, [settings]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-30 flex flex-col overflow-hidden">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/60 to-black/85 backdrop-blur-sm" />

      {/* Bunny mascot */}
      {screen === "main" && (
        <img
          src={bunnyGirl}
          alt="Bunny Arena mascot"
          width={768}
          height={1280}
          className="pointer-events-none absolute bottom-0 right-[-8%] z-[5] h-[85%] w-auto max-w-none select-none drop-shadow-[0_10px_40px_rgba(236,72,153,0.45)] sm:right-[-4%] sm:h-[92%]"
          style={{ WebkitMaskImage: "linear-gradient(to bottom, black 88%, transparent 100%)", maskImage: "linear-gradient(to bottom, black 88%, transparent 100%)" }}
        />
      )}

      <div className="relative z-10 flex h-full flex-col items-center justify-start px-4 py-6 text-white">
        {screen === "main" && (
          <MainScreen
            best={best}
            coins={coins}
            onPlay={onPlay}
            onGo={setScreen}
          />
        )}
        {screen === "shop" && (
          <ShopScreen
            coins={coins}
            owned={owned}
            skin={skin}
            onBuy={(id, price) => {
              if (owned.includes(id) || coins < price) return;
              const nc = coins - price;
              const no = [...owned, id];
              setCoins(nc);
              setOwned(no);
              writeJSON(LS.coins, nc);
              writeJSON(LS.owned, no);
            }}
            onEquip={(id) => {
              setSkin(id);
              writeJSON(LS.skin, id);
              applyCharacterSkin(id);
            }}
            onEarn={() => {
              const nc = coins + 50;
              setCoins(nc);
              writeJSON(LS.coins, nc);
            }}
            onBack={() => setScreen("main")}
          />
        )}
        {screen === "settings" && (
          <SettingsScreen
            settings={settings}
            onChange={setSettings}
            onReset={() => setSettings(DEFAULT_SETTINGS)}
            onBack={() => setScreen("main")}
          />
        )}
        {screen === "ranking" && (
          <RankingScreen
            ranking={ranking}
            currentKills={currentKills}
            onSubmit={(name) => {
              const entry = { name: name || "Player", kills: currentKills, date: new Date().toISOString() };
              const next = [...ranking, entry].sort((a, b) => b.kills - a.kills).slice(0, 10);
              setRanking(next);
              writeJSON(LS.ranking, next);
            }}
            onClear={() => {
              setRanking([]);
              writeJSON(LS.ranking, []);
            }}
            onBack={() => setScreen("main")}
          />
        )}
        {screen === "exit" && (
          <ExitScreen
            onCancel={() => setScreen("main")}
            onConfirm={() => {
              // Best-effort: close tab, else fallback to blank page.
              window.close();
              window.location.href = "about:blank";
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------- Screens ---------------- */

function Title() {
  return (
    <div className="mb-4 select-none text-center">
      <h1
        className="text-5xl font-black tracking-wider text-white drop-shadow-[0_0_16px_rgba(236,72,153,0.9)] sm:text-6xl"
        style={{ textShadow: "0 0 12px rgba(255,255,255,0.8), 0 0 30px rgba(236,72,153,0.7)" }}
      >
        BUNNY
      </h1>
      <h1
        className="-mt-2 text-5xl font-black tracking-wider text-white drop-shadow-[0_0_16px_rgba(59,130,246,0.9)] sm:text-6xl"
        style={{ textShadow: "0 0 12px rgba(255,255,255,0.8), 0 0 30px rgba(59,130,246,0.7)" }}
      >
        ARENA
      </h1>
    </div>
  );
}

function NeonButton({
  color,
  children,
  onClick,
  disabled,
}: {
  color: string;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="pointer-events-auto w-full rounded-2xl border-2 bg-black/50 px-6 py-3 text-2xl font-black tracking-wider text-white transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        borderColor: color,
        boxShadow: `0 0 18px ${color}, inset 0 0 14px ${color}55`,
        textShadow: `0 0 8px ${color}`,
      }}
    >
      {children}
    </button>
  );
}

function MainScreen({
  best,
  coins,
  onPlay,
  onGo,
}: {
  best: number;
  coins: number;
  onPlay: () => void;
  onGo: (s: Screen) => void;
}) {
  return (
    <div className="pointer-events-auto flex w-full max-w-sm flex-1 flex-col">
      <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-widest opacity-80">
        <span>🏆 Melhor: {best}</span>
        <span>🪙 {coins}</span>
      </div>
      <Title />
      <div className="mt-auto flex w-full flex-col gap-3 rounded-3xl border border-white/10 bg-black/40 p-4 backdrop-blur">
        <NeonButton color="#ef4444" onClick={onPlay}>JOGAR</NeonButton>
        <NeonButton color="#eab308" onClick={() => onGo("shop")}>LOJA</NeonButton>
        <NeonButton color="#3b82f6" onClick={() => onGo("settings")}>CONFIGURAÇÕES</NeonButton>
        <NeonButton color="#a855f7" onClick={() => onGo("ranking")}>RANKING</NeonButton>
        <NeonButton color="#334155" onClick={() => onGo("exit")}>SAIR</NeonButton>
      </div>
    </div>
  );
}

function Panel({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="pointer-events-auto flex w-full max-w-sm flex-1 flex-col gap-3">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="rounded-full border border-white/30 bg-black/40 px-4 py-1 text-sm font-semibold hover:bg-white/10"
        >
          ← Voltar
        </button>
        <h2 className="text-xl font-black tracking-widest">{title}</h2>
        <div className="w-16" />
      </div>
      <div className="flex-1 overflow-y-auto rounded-3xl border border-white/10 bg-black/50 p-4 backdrop-blur">
        {children}
      </div>
    </div>
  );
}

function ShopScreen({
  coins,
  owned,
  skin,
  onBuy,
  onEquip,
  onEarn,
  onBack,
}: {
  coins: number;
  owned: string[];
  skin: string;
  onBuy: (id: string, price: number) => void;
  onEquip: (id: string) => void;
  onEarn: () => void;
  onBack: () => void;
}) {
  return (
    <Panel title="LOJA" onBack={onBack}>
      <div className="mb-3 flex items-center justify-between text-sm">
        <span className="font-semibold">🪙 {coins} moedas</span>
        <button
          onClick={onEarn}
          className="rounded-md bg-yellow-500/20 px-3 py-1 text-xs font-bold text-yellow-300 hover:bg-yellow-500/30"
        >
          + Ganhar 50 (dev)
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {SKINS.map((s) => {
          const isOwned = owned.includes(s.id);
          const isEquipped = skin === s.id;
          return (
            <div
              key={s.id}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-3"
            >
              <div
                className="h-10 w-10 rounded-full border-2 border-white/40"
                style={{ background: s.color }}
              />
              <div className="flex-1">
                <div className="text-sm font-bold">{s.name}</div>
                <div className="text-xs opacity-70">
                  {isOwned ? "Adquirido" : `${s.price} moedas`}
                </div>
              </div>
              {isOwned ? (
                <button
                  onClick={() => onEquip(s.id)}
                  disabled={isEquipped}
                  className="rounded-md bg-emerald-500/80 px-3 py-1 text-xs font-bold disabled:opacity-60"
                >
                  {isEquipped ? "Equipado" : "Equipar"}
                </button>
              ) : (
                <button
                  onClick={() => onBuy(s.id, s.price)}
                  disabled={coins < s.price}
                  className="rounded-md bg-yellow-500 px-3 py-1 text-xs font-bold text-black disabled:opacity-40"
                >
                  Comprar
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function SettingsScreen({
  settings,
  onChange,
  onReset,
  onBack,
}: {
  settings: BunnySettings;
  onChange: (s: BunnySettings) => void;
  onReset: () => void;
  onBack: () => void;
}) {
  const Slider = ({ label, value, onSet }: { label: string; value: number; onSet: (v: number) => void }) => (
    <label className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-sm font-semibold">
        <span>{label}</span>
        <span className="opacity-70">{value}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onSet(Number(e.target.value))}
        className="accent-pink-500"
      />
    </label>
  );
  return (
    <Panel title="CONFIGURAÇÕES" onBack={onBack}>
      <div className="flex flex-col gap-4">
        <Slider label="Volume música" value={settings.volume} onSet={(v) => onChange({ ...settings, volume: v })} />
        <Slider label="Efeitos sonoros" value={settings.sfx} onSet={(v) => onChange({ ...settings, sfx: v })} />
        <Slider label="Sensibilidade câmera" value={settings.sensitivity} onSet={(v) => onChange({ ...settings, sensitivity: v })} />
        <label className="flex flex-col gap-1 text-sm font-semibold">
          <span>Qualidade gráfica</span>
          <div className="flex gap-2">
            {(["low", "medium", "high"] as const).map((q) => (
              <button
                key={q}
                onClick={() => onChange({ ...settings, quality: q })}
                className={`flex-1 rounded-md px-2 py-2 text-xs font-bold uppercase ${
                  settings.quality === q ? "bg-blue-500 text-white" : "bg-white/10 hover:bg-white/20"
                }`}
              >
                {q === "low" ? "Baixa" : q === "medium" ? "Média" : "Alta"}
              </button>
            ))}
          </div>
        </label>
        <button
          onClick={onReset}
          className="mt-2 rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm font-semibold hover:bg-white/10"
        >
          Restaurar padrões
        </button>
      </div>
    </Panel>
  );
}

function RankingScreen({
  ranking,
  currentKills,
  onSubmit,
  onClear,
  onBack,
}: {
  ranking: { name: string; kills: number; date: string }[];
  currentKills: number;
  onSubmit: (name: string) => void;
  onClear: () => void;
  onBack: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <Panel title="RANKING" onBack={onBack}>
      <div className="mb-3 rounded-xl border border-white/10 bg-white/5 p-3">
        <div className="text-xs uppercase opacity-70">Sua partida atual</div>
        <div className="mb-2 text-2xl font-black">{currentKills} kills</div>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 16))}
            placeholder="Seu nome"
            className="flex-1 rounded-md border border-white/20 bg-black/40 px-2 py-1 text-sm outline-none focus:border-pink-400"
          />
          <button
            onClick={() => onSubmit(name)}
            className="rounded-md bg-purple-500 px-3 py-1 text-sm font-bold hover:bg-purple-400"
          >
            Salvar
          </button>
        </div>
      </div>
      {ranking.length === 0 ? (
        <div className="py-6 text-center text-sm opacity-70">Nenhum registro ainda.</div>
      ) : (
        <ol className="flex flex-col gap-1">
          {ranking.map((r, i) => (
            <li
              key={`${r.name}-${r.date}`}
              className="flex items-center justify-between rounded-md bg-white/5 px-3 py-2 text-sm"
            >
              <span className="font-bold">
                {i + 1}. {r.name}
              </span>
              <span className="font-mono">{r.kills}</span>
            </li>
          ))}
        </ol>
      )}
      {ranking.length > 0 && (
        <button
          onClick={onClear}
          className="mt-3 w-full rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-300 hover:bg-red-500/20"
        >
          Limpar ranking
        </button>
      )}
    </Panel>
  );
}

function ExitScreen({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="pointer-events-auto m-auto flex w-full max-w-sm flex-col gap-4 rounded-3xl border border-white/10 bg-black/60 p-6 text-center backdrop-blur">
      <h2 className="text-2xl font-black tracking-widest">SAIR DO JOGO?</h2>
      <p className="text-sm opacity-80">Seu progresso salvo permanece.</p>
      <div className="flex gap-3">
        <button
          onClick={onCancel}
          className="flex-1 rounded-xl border border-white/30 bg-white/5 px-4 py-2 font-bold hover:bg-white/10"
        >
          Cancelar
        </button>
        <button
          onClick={onConfirm}
          className="flex-1 rounded-xl bg-red-500 px-4 py-2 font-bold hover:bg-red-400"
        >
          Sair
        </button>
      </div>
    </div>
  );
}