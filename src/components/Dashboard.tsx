import { useMemo, useState } from "react";
import type { Project } from "../types/editor";
import { formatTime } from "../utils/format";

interface Props {
  projects: Project[];
  onNewProject: (title: string, aspect: Project["settings"]["aspect"]) => void;
  onOpenProject: (project: Project) => void;
  onDeleteProject: (id: string) => void;
}

function projectDuration(p: Project): number {
  let max = 0;
  for (const t of p.tracks) for (const c of t.clips) max = Math.max(max, c.start + c.duration);
  return max;
}

export function Dashboard({ projects, onNewProject, onOpenProject, onDeleteProject }: Props) {
  const [title, setTitle] = useState("Untitled Project");
  const [aspect, setAspect] = useState<Project["settings"]["aspect"]>("16:9");

  const templates = useMemo(() => [
    { name: "YouTube / Landscape", aspect: "16:9" as const, desc: "1920×1080 · 16:9" },
    { name: "TikTok / Reels", aspect: "9:16" as const, desc: "1080×1920 · 9:16" },
    { name: "Square Post", aspect: "1:1" as const, desc: "1080×1080 · 1:1" },
  ], []);

  return (
    <div className="app-shell dashboard">
      <header className="topbar">
        <div className="brand">Apex <span>Editor</span></div>
        <span className="badge good"><span className="dot" />Professional Suite</span>
        <div className="spacer" />
        <span className="tiny">Multi-track · AI-ready · Fast export</span>
      </header>

      <main className="dash-main">
        <section className="dash-hero card">
          <div>
            <h1>Create something new</h1>
            <p className="hint">A full-featured, browser-based video editing suite. Import media, edit on a multi-track timeline, and export fast.</p>
          </div>
          <div className="new-project-form">
            <label htmlFor="proj-title">Project name</label>
            <input id="proj-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled Project" />
            <label htmlFor="proj-aspect">Aspect ratio</label>
            <select id="proj-aspect" value={aspect} onChange={(e) => setAspect(e.target.value as Project["settings"]["aspect"])}>
              <option value="16:9">16:9 Landscape (YouTube)</option>
              <option value="9:16">9:16 Vertical (TikTok/Reels)</option>
              <option value="1:1">1:1 Square</option>
            </select>
            <button className="primary large" onClick={() => onNewProject(title.trim() || "Untitled Project", aspect)}>+ New Project</button>
          </div>
        </section>

        <section className="card">
          <div className="section-head"><h2>Template shortcuts</h2></div>
          <div className="template-grid">
            {templates.map((t) => (
              <button key={t.aspect} className="template-card" onClick={() => onNewProject(t.name, t.aspect)}>
                <div className={`template-thumb aspect-${t.aspect.replace(":", "-")}`} />
                <div className="template-meta">
                  <strong>{t.name}</strong>
                  <span>{t.desc}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="section-head"><h2>Quick tools</h2><span className="tiny">Open a project to use timeline, AI, and export tools</span></div>
          <div className="quick-tools">
            <div className="quick-tool"><strong>Auto-Captions</strong><span>Speech-to-text subtitles synced to timeline</span></div>
            <div className="quick-tool"><strong>Background Removal</strong><span>Chroma key and AI cutout toggle</span></div>
            <div className="quick-tool"><strong>AI Generator & AutoCut</strong><span>Prompt hooks to /v1/chat/completions and /v1/tts</span></div>
            <div className="quick-tool"><strong>Retouch & Speed</strong><span>Brightness, contrast, saturation, 0.1x–100x speed</span></div>
            <div className="quick-tool"><strong>Fast Export</strong><span>Remux/copy fast path + WebCodecs hardware encode, 720p–4K</span></div>
          </div>
        </section>

        <section className="card">
          <div className="section-head"><h2>Project history</h2><span className="tiny">{projects.length ? `${projects.length} saved locally` : "No saved projects yet"}</span></div>
          {projects.length === 0 ? (
            <p className="hint">Projects you create and edit are saved locally in this browser. Open one to continue where you left off.</p>
          ) : (
            <div className="project-grid">
              {projects.map((p) => (
                <div key={p.id} className="project-card">
                  <button className="project-open" onClick={() => onOpenProject(p)}>
                    <div className="project-thumb">
                      {p.thumbnailDataUrl ? <img src={p.thumbnailDataUrl} alt="" /> : <div className="thumb-placeholder">{p.settings.aspect}</div>}
                    </div>
                    <div className="project-meta">
                      <strong>{p.title}</strong>
                      <span>{p.settings.aspect} · {p.settings.width}×{p.settings.height} · {formatTime(projectDuration(p))}</span>
                      <span className="tiny">Updated {new Date(p.updatedAt).toLocaleString()}</span>
                    </div>
                  </button>
                  <button className="danger-link" onClick={() => { if (confirm(`Delete "${p.title}" from local history?`)) onDeleteProject(p.id); }}>Delete</button>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
