import {
	createOrcaTerminal,
	getOrcaTerminalWorktreeId,
	renameOrcaTerminal,
	renameOrcaWorktreeDisplayName,
	splitOrcaTerminal,
} from "./orca.ts";

type SurfaceSplitDirection = "left" | "right" | "up" | "down";

function assertSupportedOrcaSplitDirection(
	direction: SurfaceSplitDirection,
): asserts direction is "right" | "down" {
	if (direction === "right" || direction === "down") return;
	throw new Error(
		`Orca split direction "${direction}" is unsupported; Orca terminal split supports only right and down`,
	);
}

function currentOrcaWorktreeSelector(): string | undefined {
	const handle = process.env.PI_SUBAGENT_SURFACE?.trim();
	if (!handle) return undefined;
	try {
		return getOrcaTerminalWorktreeId(handle);
	} catch {
		return undefined;
	}
}

export function createOrcaSurface(name: string): string {
	return createOrcaTerminal(name, currentOrcaWorktreeSelector());
}

export function createOrcaSplit(
	_name: string,
	direction: SurfaceSplitDirection,
	fromSurface?: string,
): string {
	if (!fromSurface) {
		throw new Error(
			"createOrcaSplit requires fromSurface; resolve the active terminal handle before splitting",
		);
	}
	assertSupportedOrcaSplitDirection(direction);
	const orcaDirection = direction === "right" ? "horizontal" : "vertical";
	return splitOrcaTerminal(fromSurface, orcaDirection);
}

export function renameOrcaCurrentTab(title: string): void {
	const handle = process.env.PI_SUBAGENT_SURFACE?.trim();
	if (!handle) {
		throw new Error(
			"PI_SUBAGENT_SURFACE not set; cannot rename Orca terminal tab",
		);
	}
	renameOrcaTerminal(handle, title);
}

export function renameOrcaCurrentWorkspace(title: string): void {
	if (process.env.PI_SUBAGENT_RENAME_ORCA_WORKTREE !== "1") return;
	renameOrcaWorktreeDisplayName(title, currentOrcaWorktreeSelector());
}
