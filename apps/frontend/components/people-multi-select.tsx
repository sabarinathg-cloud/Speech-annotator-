"use client";

import type { AdminUser } from "@outcomes/shared-types";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface PeopleMultiSelectProps {
  users: AdminUser[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

function orderedSelection(users: AdminUser[], selectedIds: string[]): string[] {
  const selected = new Set(selectedIds);
  return users.filter((user) => selected.has(user.id)).map((user) => user.id);
}

function summaryText(count: number): string {
  if (count === 0) return "People: All people";
  if (count === 1) return "People: 1 person selected";
  return `People: ${count} people selected`;
}

export function PeopleMultiSelect({ users, selectedIds, onChange }: PeopleMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const normalizedSelectedIds = useMemo(() => orderedSelection(users, selectedIds), [selectedIds, users]);
  const selectedSet = useMemo(() => new Set(normalizedSelectedIds), [normalizedSelectedIds]);
  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) => {
      const name = user.full_name.toLowerCase();
      const email = user.email.toLowerCase();
      return name.includes(query) || email.includes(query);
    });
  }, [search, users]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function setOrderedSelection(nextIds: string[]): void {
    onChange(orderedSelection(users, nextIds));
  }

  function toggleUser(userId: string): void {
    if (selectedSet.has(userId)) {
      setOrderedSelection(normalizedSelectedIds.filter((id) => id !== userId));
      return;
    }
    setOrderedSelection([...normalizedSelectedIds, userId]);
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="oa-input mt-1 flex min-h-10 w-full items-center justify-between gap-2 text-left text-sm font-medium text-[#241f43]"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="truncate">{summaryText(normalizedSelectedIds.length)}</span>
        <span aria-hidden="true" className="text-[#706a87]">
          v
        </span>
      </button>
      {open ? (
        <div
          aria-label="People filter"
          className="absolute left-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-md border border-[#ded3ee] bg-white p-3 shadow-lg"
          id={panelId}
          role="dialog"
        >
          <label className="block text-xs font-semibold text-[#5f5878]">
            Search people
            <input
              aria-label="Search people"
              className="oa-input mt-1 w-full"
              role="searchbox"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="mt-3 flex items-center gap-2">
            <button
              className="oa-btn-secondary px-3 py-1.5 text-xs"
              type="button"
              onClick={() => setOrderedSelection(users.map((user) => user.id))}
            >
              Select all
            </button>
            <button className="oa-btn-secondary px-3 py-1.5 text-xs" type="button" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          <div aria-label="People options" className="mt-3 max-h-56 overflow-y-auto pr-1" role="group">
            {filteredUsers.length ? (
              filteredUsers.map((user) => (
                <label
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-sm text-[#241f43] hover:bg-[#faf7fd]"
                  key={user.id}
                >
                  <input
                    aria-label={user.full_name}
                    checked={selectedSet.has(user.id)}
                    className="mt-1"
                    type="checkbox"
                    onChange={() => toggleUser(user.id)}
                  />
                  <span>
                    <span className="block font-medium">{user.full_name}</span>
                    <span className="block text-xs text-[#706a87]">{user.email}</span>
                  </span>
                </label>
              ))
            ) : (
              <p className="px-2 py-3 text-sm text-[#706a87]">No people found.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
