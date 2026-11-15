import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { FolderTreeNode } from '../types';

interface FolderTreeProps {
  nodes: FolderTreeNode[];
  currentDir: string;
  onSelectDir: (path: string) => void;
  depth?: number;
}

export function FolderTree({
  nodes,
  currentDir,
  onSelectDir,
  depth = 0,
}: FolderTreeProps) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <FolderTreeItem
          key={node.path}
          node={node}
          currentDir={currentDir}
          onSelectDir={onSelectDir}
          depth={depth}
        />
      ))}
    </div>
  );
}

function FolderTreeItem({
  node,
  currentDir,
  onSelectDir,
  depth,
}: {
  node: FolderTreeNode;
  currentDir: string;
  onSelectDir: (path: string) => void;
  depth: number;
}) {
  const isAncestor = currentDir === node.path || currentDir.startsWith(`${node.path}/`);
  const [expanded, setExpanded] = useState(depth < 1 || isAncestor);
  const isActive = currentDir === node.path;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={`group flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs transition ${
          isActive
            ? 'bg-amber-500/15 font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-200'
            : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70'
        }`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        onClick={() => onSelectDir(node.path)}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setExpanded((prev) => !prev);
          }}
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded ${
            hasChildren ? 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200' : 'opacity-0'
          }`}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>

        {isActive || (expanded && hasChildren) ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
        )}
        <span className="truncate">{node.name}</span>
      </div>

      {hasChildren && expanded && (
        <FolderTree
          nodes={node.children}
          currentDir={currentDir}
          onSelectDir={onSelectDir}
          depth={depth + 1}
        />
      )}
    </div>
  );
}
