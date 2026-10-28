import { memo } from "react";

/** Lightweight markdown for AI analysis / replies: headings, rules, list items, **bold**, *notes*. */
export const AIMarkdown = memo(function AIMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => {
        // Headers
        if (line.startsWith('## ')) return <h2 key={i} className="text-base text-gray-900 mt-4 mb-2">{line.slice(3)}</h2>;
        if (line.startsWith('### ')) return <h3 key={i} className="text-sm text-gray-800 mt-3 mb-1">{line.slice(4)}</h3>;
        if (line.startsWith('#### ')) return <h4 key={i} className="text-xs text-gray-700 mt-2 mb-1">{line.slice(5)}</h4>;
        // Horizontal rule
        if (line.startsWith('---')) return <hr key={i} className="my-3 border-gray-200" />;
        // List items
        if (line.startsWith('- **')) {
          const match = line.match(/^- \*\*(.+?)\*\*[：:](.*)$/);
          if (match) return <p key={i} className="text-xs text-gray-600 ms-3 my-0.5"><span className="text-gray-800">{match[1]}</span>：{match[2]}</p>;
        }
        if (line.startsWith('- ')) return <p key={i} className="text-xs text-gray-600 ms-3 my-0.5">{line.slice(2)}</p>;
        // Numbered items
        if (/^\d+\.\s\*\*/.test(line)) {
          const match = line.match(/^(\d+)\.\s\*\*(.+?)\*\*[：:](.*)$/);
          if (match) return <p key={i} className="text-xs text-gray-600 ms-3 my-0.5"><span className="text-emerald-700">{match[1]}.</span> <span className="text-gray-800">{match[2]}</span>：{match[3]}</p>;
        }
        // Bold text
        if (line.includes('**')) {
          const parts = line.split(/\*\*(.+?)\*\*/g);
          return <p key={i} className="text-xs text-gray-600 my-0.5">{parts.map((part, j) => j % 2 === 1 ? <span key={j} className="text-gray-800">{part}</span> : part)}</p>;
        }
        // Italic/small text
        if (line.startsWith('*') && line.endsWith('*')) return <p key={i} className="text-[10px] text-gray-400 my-0.5 italic">{line.slice(1, -1)}</p>;
        // Empty line
        if (line.trim() === '') return <div key={i} className="h-1" />;
        // Normal text
        return <p key={i} className="text-xs text-gray-600 my-0.5">{line}</p>;
      })}
    </>
  );
});
