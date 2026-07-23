import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { headers, cookies } from "next/headers";
import "./globals.css";
import AuthBootstrap from "./components/AuthBootstrap";
import { PEER_COOKIE } from "@/lib/peer-token";

// Desktop-app type tiers (DESIGN.md): Archivo for UI/display, JetBrains Mono for
// figures/code. next/font self-hosts them and exposes CSS vars consumed by
// tailwind.config's fontFamily. `swap` avoids a blocking flash of invisible text.
const archivo = Archivo({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-archivo",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "hoop - pairing with an agent",
  description: "Being alone is not a requirement",
};

// Mobile peers open the shared session on a phone. Pin the layout viewport to
// the device width (so the UI isn't rendered at a zoomed-out ~980px desktop
// width) and let content extend under the notch/home indicator — the shell
// goes edge-to-edge below `sm`. `maximumScale` is intentionally left default so
// pinch-zoom stays available (accessibility).
//
// `interactiveWidget: "resizes-content"` makes the on-screen keyboard shrink the
// *layout* viewport (and `dvh`) on Chromium, so a `100dvh` shell sits exactly
// above the keyboard — no black gap, no JS. Browsers that ignore it (iOS Safari)
// fall back to the visualViewport hook in AppShell.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

// Read HOOP_DASHBOARD_TOKEN at request time, not build time. The
// launcher writes it into the container env after the build is baked.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Mirror the per-participant synchronizer token into a meta tag the client
  // bundle reads to set x-dashboard-token on mutating requests (the HttpOnly
  // cookie is invisible to JS by design).
  //
  // CRITICAL: the install token must NEVER reach a peer. Middleware injects a
  // trusted `x-hoop-participant` header (it strips any client-supplied one):
  //   - "host"      → emit the install token (localhost operator).
  //   - "peer:<id>" → emit the peer's OWN signed token (their cookie value),
  //                   never the install token.
  //   - anything else → emit nothing.
  const hdrs = await headers();
  const participant = hdrs.get("x-hoop-participant") ?? "none";
  let token = "";
  if (participant === "host") {
    token = process.env.HOOP_DASHBOARD_TOKEN ?? "";
  } else if (participant.startsWith("peer:")) {
    token = (await cookies()).get(PEER_COOKIE)?.value ?? "";
  }
  // Non-secret: lets the client tailor UI (host sees Share; peer shows as a
  // guest in presence). "host" | "peer" | "none".
  const participantKind = participant.startsWith("peer:") ? "peer" : participant;
  // For a peer, the session they're locked to — lets the client pin selection
  // and hide session-switching. Trusted (injected by middleware).
  const peerSession = participantKind === "peer" ? hdrs.get("x-hoop-peer-session") ?? "" : "";
  // The peer's share capability (full | drive | spectate). Non-secret; lets the
  // plan-review UI show Approve/Reject only to a peer whose share permits
  // decisions. The sandbox re-validates on every action, so this is UX-only.
  const peerCapability = participantKind === "peer" ? hdrs.get("x-hoop-peer-capability") ?? "" : "";
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${archivo.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/* Resolve the theme before first paint to avoid a flash of the wrong
          * palette. "auto" follows the OS; an explicit choice is stored under
          * `hoop-theme`. Kept in sync with ThemeSwitcher. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('hoop-theme')||'auto';var dark=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',dark?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`,
          }}
        />
        {token ? <meta name="x-dashboard-token" content={token} /> : null}
        <meta name="x-hoop-participant" content={participantKind} />
        {peerSession ? <meta name="x-hoop-peer-session" content={peerSession} /> : null}
        {peerCapability ? <meta name="x-hoop-peer-capability" content={peerCapability} /> : null}
      </head>
      <body>
        <AuthBootstrap />
        {children}
      </body>
    </html>
  );
}
