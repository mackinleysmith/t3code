import type {
  ConnectionCatalogEntry,
  EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import type { ServerConfig } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import {
  buildEnvironmentUpdateGroups,
  deriveEnvironmentDisplayLabel,
  type EnvironmentProvidersInput,
  type EnvironmentUpdateConnectionState,
  type EnvironmentUpdateGroup,
} from "./ProviderUpdateLaunchNotification.logic";

/**
 * Keep the primary and desktop-local backends in the set while they start so
 * the existing settling grace still covers WSL. Remote environments join only
 * after they are connected and have loaded a live config. This prevents an
 * offline remote's cached state from advertising an update it cannot run.
 */
export function shouldIncludeProviderUpdateEnvironment(input: {
  readonly target: ConnectionCatalogEntry["target"];
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
}): boolean {
  return (
    input.target._tag === "PrimaryConnectionTarget" ||
    isDesktopLocalConnectionTarget(input.target) ||
    (input.connectionPhase === "connected" && input.hasServerConfig)
  );
}

function normalizeConnectionState(
  phase: EnvironmentConnectionPhase,
): EnvironmentUpdateConnectionState {
  switch (phase) {
    case "connected":
      return "ready";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "unsupported":
    case "error":
      return "error";
    case "offline":
      return "disconnected";
    default:
      // "available" (or anything not yet observed) — the backend has not
      // confirmed it is serving yet, so treat it as still settling so the
      // popover waits for it.
      return "connecting";
  }
}

/**
 * Reactively enumerate the primary, desktop-local backends, and connected
 * remote environments with each one's provider list. Drives the launch
 * popover's gating and its per-environment update triggers.
 */
export function useEnvironmentUpdateGroups(): {
  readonly groups: EnvironmentUpdateGroup[];
  readonly isAnySettling: boolean;
} {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  return useMemo(() => {
    const inputs: EnvironmentProvidersInput[] = [];

    for (const environment of environments) {
      if (
        !shouldIncludeProviderUpdateEnvironment({
          target: environment.entry.target,
          connectionPhase: environment.connection.phase,
          hasServerConfig: environment.serverConfig !== null,
        })
      ) {
        continue;
      }

      const isPrimary = environment.environmentId === primaryEnvironmentId;
      const serverConfig: ServerConfig | null = environment.serverConfig;

      inputs.push({
        environmentId: environment.environmentId,
        // Secondaries carry a meaningful label straight from the connection
        // catalog. The primary's label can be the account name, so fall back to
        // its platform OS and keep the rows distinguishable.
        label: isPrimary
          ? deriveEnvironmentDisplayLabel({
              isWsl: false,
              wslDistro: null,
              platformOs: serverConfig?.environment.platform.os,
              fallbackLabel: environment.label,
            })
          : environment.label,
        isPrimary,
        // The primary serves this renderer, so it is ready whenever its
        // providers are available. Secondaries report their live phase.
        connectionState: isPrimary
          ? "ready"
          : normalizeConnectionState(environment.connection.phase),
        providers: serverConfig?.providers ?? [],
      });
    }

    // Primary first, then the rest in catalog order.
    inputs.sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));

    return buildEnvironmentUpdateGroups(inputs);
  }, [environments, primaryEnvironmentId]);
}
