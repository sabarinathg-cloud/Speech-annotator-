import type { TaskStatus } from "@outcomes/shared-types";
import clsx from "clsx";

const statusClass: Record<TaskStatus, string> = {
  "Not Started": "border-[#e6ddf3] bg-[#f7f3fd] text-[#5b5474]",
  "In Progress": "border-[#bfd8ff] bg-[#eaf2ff] text-[#27497f]",
  Completed: "border-[#ffd4c8] bg-[#ffece6] text-[#8a422b]",
  "Needs Review": "border-[#dfc7ff] bg-[#f3ebff] text-[#5b3292]",
  Reviewed: "border-[#d2d9ff] bg-[#eef1ff] text-[#3e4f98]",
  Approved: "border-[#bfe7cf] bg-[#eafaf0] text-[#236140]",
  Rejected: "border-[#f0c8c8] bg-[#fff3f3] text-[#a13a3a]"
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium tracking-[0.01em]",
        statusClass[status]
      )}
    >
      {status}
    </span>
  );
}
