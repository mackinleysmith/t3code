import { useNavigate } from "@tanstack/react-router";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironments } from "~/state/environments";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { ProviderUpdateEnvironmentRows } from "./ProviderUpdateEnvironmentRows";
import { useEnvironmentUpdateGroups } from "./ProviderUpdateLaunchNotification.environments";
import {
  collectProviderUpdateCandidates,
  environmentGroupsWithUpdates,
  environmentUpdateNotificationKeys,
  getProviderUpdateInitialToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * True when the catalog holds any environment besides the primary. This reads
 * catalog presence, not connection state, so the choice of flow stays put while
 * a remote connects, drops, or reconnects. Which environments actually appear
 * in the popover is decided separately, per environment.
 */
function useHasSecondaryEnvironment(): boolean {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      environments.some(
        (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
      ),
    [environments],
  );
}

/**
 * Split provider updates by environment when the user has any secondary
 * environment. Single-environment users keep the simpler flow.
 */
export function ProviderUpdateLaunchNotification() {
  const hasSecondary = useHasSecondaryEnvironment();

  return hasSecondary ? (
    <ProviderUpdateEnvironmentsNotification />
  ) : (
    <ProviderUpdatePrimaryNotification />
  );
}

// Updates already offered this session, so closing the prompt through
// "Settings" does not immediately re-open it.
const seenProviderUpdateNotificationKeys = new Set<string>();
type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;

// While a desktop-local backend such as WSL is connecting, defer the popover so
// it reflects every environment. Remote environments join only when connected,
// so an offline machine never consumes this grace period.
const SETTLING_GRACE_MS = 30_000;

function ProviderUpdateEnvironmentsNotification() {
  const navigate = useNavigate();
  const { groups, isAnySettling } = useEnvironmentUpdateGroups();
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();

  const activeToastRef = useRef<{
    readonly toastId: ProviderUpdateToastId;
    /** Every update this prompt has offered, so an unanswered close can un-see them. */
    readonly shownKeys: Set<string>;
    title: string;
  } | null>(null);
  const notificationKeysRef = useRef<ReadonlyArray<string>>([]);
  // Whether the user has triggered an update from the current toast. Afterward
  // the prompt is kept even when no updates remain, so its result rows survive.
  const hasInteractedRef = useRef(false);

  // Close a prompt nobody answered and forget that it was shown, so the same
  // updates are offered again next time they are available.
  const closeUnansweredPrompt = useCallback(() => {
    const active = activeToastRef.current;
    if (active === null) {
      return;
    }
    if (!hasInteractedRef.current) {
      for (const key of active.shownKeys) {
        seenProviderUpdateNotificationKeys.delete(key);
      }
    }
    toastManager.close(active.toastId);
    activeToastRef.current = null;
  }, []);

  // Close our prompt if the last secondary is removed and the root falls back
  // to the single-environment flow.
  useEffect(() => closeUnansweredPrompt, [closeUnansweredPrompt]);

  const updateGroups = useMemo(() => environmentGroupsWithUpdates(groups), [groups]);
  const notificationKeys = useMemo(() => environmentUpdateNotificationKeys(groups), [groups]);
  useEffect(() => {
    notificationKeysRef.current = notificationKeys;
  }, [notificationKeys]);

  // Title summarizes the distinct providers on offer across all environments;
  // the per-environment detail lives in the popover body.
  const title = useMemo(() => {
    const candidateUnion = collectProviderUpdateCandidates(
      updateGroups.flatMap((group) => group.candidates),
    );
    return getProviderUpdateInitialToastView({
      updateProviders: candidateUnion,
      oneClickProviders: candidateUnion,
    }).title;
  }, [updateGroups]);

  // Defer while a desktop-local backend is still connecting, up to the grace period.
  const [settleGraceElapsed, setSettleGraceElapsed] = useState(false);
  useEffect(() => {
    if (!isAnySettling) {
      setSettleGraceElapsed(false);
      return;
    }
    const timer = setTimeout(() => setSettleGraceElapsed(true), SETTLING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isAnySettling]);
  const isGated = isAnySettling && !settleGraceElapsed;

  const openProviderSettings = useCallback(() => {
    const active = activeToastRef.current;
    if (active !== null) {
      toastManager.close(active.toastId);
      activeToastRef.current = null;
    }
    void navigate({ to: "/settings/providers" });
  }, [navigate]);

  useEffect(() => {
    const active = activeToastRef.current;
    if (active !== null) {
      if (hasInteractedRef.current) {
        return;
      }
      if (notificationKeys.length === 0) {
        closeUnansweredPrompt();
        return;
      }
      // The rows render live, so an open prompt follows environments as they
      // connect and drop without being closed and re-opened. Only the title is
      // static, so refresh it when the set of providers on offer changes.
      for (const key of notificationKeys) {
        active.shownKeys.add(key);
        seenProviderUpdateNotificationKeys.add(key);
      }
      if (active.title !== title) {
        toastManager.update(active.toastId, { title });
        active.title = title;
      }
      return;
    }

    const hasNewUpdate = notificationKeys.some(
      (key) => !dismissedNotificationKeys.has(key) && !seenProviderUpdateNotificationKeys.has(key),
    );
    if (!hasNewUpdate || isGated) {
      return;
    }

    for (const key of notificationKeys) {
      seenProviderUpdateNotificationKeys.add(key);
    }
    hasInteractedRef.current = false;

    const dismissPrompt = () => {
      // Dismiss whatever is still on offer at close time, so the popover does
      // not re-pop for updates the user just declined.
      dismissNotificationKey(...notificationKeysRef.current);
      activeToastRef.current = null;
    };

    const toastId = toastManager.add(
      stackedThreadToast({
        type: "warning",
        title,
        description: (
          <ProviderUpdateEnvironmentRows
            onInteract={() => {
              hasInteractedRef.current = true;
            }}
          />
        ),
        timeout: 0,
        actionProps: {
          children: "Settings",
          onClick: openProviderSettings,
        },
        actionVariant: "outline",
        data: {
          hideCopyButton: true,
          leadingIcon: <DownloadIcon aria-hidden="true" className="size-4 text-success" />,
          onClose: dismissPrompt,
        },
      }),
    );
    activeToastRef.current = { toastId, shownKeys: new Set(notificationKeys), title };
  }, [
    notificationKeys,
    title,
    isGated,
    closeUnansweredPrompt,
    dismissedNotificationKeys,
    dismissNotificationKey,
    openProviderSettings,
  ]);

  return null;
}
