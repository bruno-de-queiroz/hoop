import { headers } from "next/headers";
import { DashboardProviders } from "./context/DashboardProviders";
import { DesktopShell } from "./components/shell/DesktopShell";

export const dynamic = "force-dynamic";

export default function DashboardHome() {
  // A peer is a guest in the host's session — hide host-only surfaces: the
  // session switcher/list and the host's authenticated identity.
  // Middleware injects the trusted header as `peer:<shareId>` (not a bare
  // "peer"), so match the prefix — an exact "peer" check never fires.
  const isPeer = (headers().get("x-hoop-participant") ?? "").startsWith("peer:");
  const port = process.env.HOOP_PORT ?? "7842";

  return (
    <DashboardProviders>
      <DesktopShell isPeer={isPeer} port={port} />
    </DashboardProviders>
  );
}
