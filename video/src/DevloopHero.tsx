import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const C = {
  bg: "#0d1117",
  panel: "#161b22",
  edge: "#30363d",
  fg: "#c9d1d9",
  dim: "#8b949e",
  cyan: "#56d4dd",
  blue: "#588cff",
  amber: "#ffd33d",
};
const MONO =
  "ui-monospace, SFMono-Regular, Menlo, 'DejaVu Sans Mono', monospace";
const TS = "12:04:08.231";

// ---- the d-mark, drawn in ----
const Logo: React.FC<{ size?: number }> = ({ size = 260 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const draw = interpolate(frame, [0, 45], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const circ = 2 * Math.PI * 46;
  const dot = spring({ frame: frame - 38, fps, config: { damping: 12 } });
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
      <defs>
        <linearGradient id="g" x1="82" y1="80" x2="186" y2="196" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={C.cyan} />
          <stop offset="1" stopColor={C.blue} />
        </linearGradient>
      </defs>
      <path
        d="M 174 56 L 174 196"
        stroke="url(#g)"
        strokeWidth={24}
        strokeLinecap="round"
        strokeDasharray={140}
        strokeDashoffset={140 * draw}
      />
      <circle
        cx={128}
        cy={150}
        r={46}
        stroke="url(#g)"
        strokeWidth={24}
        fill="none"
        strokeDasharray={circ}
        strokeDashoffset={circ * draw}
        transform="rotate(-90 128 150)"
      />
      <circle cx={128} cy={150} r={15 * dot} fill={C.amber} />
    </svg>
  );
};

// ---- a single log/event card ----
const EventCard: React.FC<{
  accent: string;
  kind: string;
  line: string;
}> = ({ accent, kind, line }) => {
  return (
    <div
      style={{
        width: 460,
        background: C.panel,
        border: `1px solid ${C.edge}`,
        borderRadius: 14,
        padding: "20px 24px",
        fontFamily: MONO,
        boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ width: 12, height: 12, borderRadius: 99, background: accent }} />
        <span style={{ color: accent, fontSize: 20, fontWeight: 600 }}>{kind}</span>
        <span style={{ color: C.dim, fontSize: 18, marginLeft: "auto" }}>{TS}</span>
      </div>
      <div style={{ color: C.fg, fontSize: 19, lineHeight: 1.5 }}>{line}</div>
    </div>
  );
};

// ---- Scene 1: logo intro ----
const SceneLogo: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12, 70, 88], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity }}>
      <Logo />
      <div style={{ fontFamily: MONO, color: C.fg, fontSize: 56, fontWeight: 700, letterSpacing: -1, marginTop: 18 }}>
        Devloop
      </div>
    </AbsoluteFill>
  );
};

// ---- Scene 2: two sides, same moment ----
const SceneSplit: React.FC = () => {
  const frame = useCurrentFrame();
  const lx = interpolate(frame, [0, 24], [-60, 0], { extrapolateRight: "clamp" });
  const rx = interpolate(frame, [0, 24], [60, 0], { extrapolateRight: "clamp" });
  const opacity = interpolate(frame, [0, 16, 95, 115], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity }}>
      <div style={{ fontFamily: MONO, color: C.dim, fontSize: 22, marginBottom: 34 }}>
        one error. two sides. same timestamp.
      </div>
      <div style={{ display: "flex", gap: 36 }}>
        <div style={{ transform: `translateX(${lx}px)` }}>
          <EventCard accent={C.cyan} kind="browser · console" line="TypeError: cannot read 'id' of undefined" />
        </div>
        <div style={{ transform: `translateX(${rx}px)` }}>
          <EventCard accent={C.blue} kind="dev server · stderr" line="NullPointer at UserService.get (user.ts:42)" />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---- Scene 3: converge onto one timeline ----
const SceneTimeline: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, 16, 85, 100], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const grow = spring({ frame, fps, config: { damping: 16 } });
  const pulse = 1 + 0.18 * Math.sin((frame / fps) * 6);
  const W = 880;
  const marker = 0.5; // correlated moment position (fraction)
  const Row: React.FC<{ y: number; accent: string; dots: number[]; label: string }> = ({ y, accent, dots, label }) => (
    <>
      <text x={0} y={y - 16} fill={C.dim} fontSize={18} fontFamily={MONO}>{label}</text>
      <line x1={0} y1={y} x2={W * grow} y2={y} stroke={C.edge} strokeWidth={3} />
      {dots.map((d, i) => (
        <circle key={i} cx={W * d * grow} cy={y} r={Math.abs(d - marker) < 0.001 ? 9 : 6}
          fill={Math.abs(d - marker) < 0.001 ? accent : C.dim} />
      ))}
    </>
  );
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity }}>
      <svg width={W} height={260} style={{ overflow: "visible" }}>
        <Row y={70} accent={C.cyan} dots={[0.12, 0.3, 0.5, 0.74]} label="browser" />
        <Row y={170} accent={C.blue} dots={[0.18, 0.5, 0.62, 0.88]} label="dev server" />
        {/* correlated moment marker */}
        <line x1={W * marker} y1={36} x2={W * marker} y2={204} stroke={C.amber} strokeWidth={3} opacity={grow} />
        <circle cx={W * marker} cy={120} r={13 * pulse} fill={C.amber} opacity={grow} />
      </svg>
      <div style={{ fontFamily: MONO, color: C.fg, fontSize: 30, fontWeight: 600, marginTop: 40, opacity: grow }}>
        one correlated timeline
      </div>
    </AbsoluteFill>
  );
};

// ---- Scene 4: outro ----
const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  const up = interpolate(frame, [0, 24], [20, 0], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity }}>
      <div style={{ transform: `translateY(${up}px)`, textAlign: "center", fontFamily: MONO }}>
        <Logo size={120} />
        <div style={{ color: C.fg, fontSize: 40, fontWeight: 700, marginTop: 10 }}>
          Browser + dev-server logs on one timeline
        </div>
        <div style={{ color: C.dim, fontSize: 24, marginTop: 14 }}>for AI agents and humans</div>
        <div
          style={{
            display: "inline-block",
            marginTop: 30,
            padding: "12px 22px",
            border: `1px solid ${C.edge}`,
            borderRadius: 10,
            background: C.panel,
            color: "#cae3ff",
            fontSize: 22,
          }}
        >
          npx -y devloop-mcp
        </div>
        <div style={{ color: C.cyan, fontSize: 26, marginTop: 26, fontWeight: 600 }}>devloop.build</div>
      </div>
    </AbsoluteFill>
  );
};

export const DevloopHero: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {/* subtle radial glow */}
      <AbsoluteFill
        style={{
          background: "radial-gradient(900px 600px at 50% 12%, #1b2030 0%, transparent 60%)",
        }}
      />
      <Sequence from={0} durationInFrames={90}>
        <SceneLogo />
      </Sequence>
      <Sequence from={80} durationInFrames={120}>
        <SceneSplit />
      </Sequence>
      <Sequence from={190} durationInFrames={100}>
        <SceneTimeline />
      </Sequence>
      <Sequence from={285} durationInFrames={150}>
        <SceneOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
