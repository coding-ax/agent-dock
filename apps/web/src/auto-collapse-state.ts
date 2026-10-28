export interface ManualDisclosureState {
  active: boolean;
  open: boolean;
}

/** A manual choice only applies while the process remains in the same phase. */
export function autoCollapseOpen(active: boolean, manual?: ManualDisclosureState): boolean {
  return manual?.active === active ? manual.open : active;
}

export function toggleAutoCollapse(active: boolean, manual?: ManualDisclosureState): ManualDisclosureState {
  return { active, open: !autoCollapseOpen(active, manual) };
}
