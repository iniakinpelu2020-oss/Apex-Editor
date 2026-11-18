import { useCallback, useEffect, useState } from "react";
import { Dashboard } from "./components/Dashboard";
import { EditorScreen } from "./components/EditorScreen";
import { EditorProvider, useEditor } from "./store/editorStore";
import { listStoredProjects, saveStoredProject, deleteStoredProject } from "./lib/project";
import type { Project } from "./types/editor";

type Screen = { name: "dashboard" } | { name: "editor" };

function AppInner() {
  const [screen, setScreen] = useState<Screen>({ name: "dashboard" });
  const [projects, setProjects] = useState<Project[]>(() => listStoredProjects());
  const { project, dispatch } = useEditor();

  const refreshProjects = useCallback(() => setProjects(listStoredProjects()), []);

  const openProject = useCallback((p: Project) => {
    dispatch({ type: "LOAD_PROJECT", project: p });
    setScreen({ name: "editor" });
  }, [dispatch]);

  const newProject = useCallback((title: string, aspect: Project["settings"]["aspect"]) => {
    dispatch({ type: "NEW_PROJECT", title, aspect });
    setScreen({ name: "editor" });
  }, [dispatch]);

  const goHome = useCallback(() => {
    // Persist current project to local history when leaving editor.
    saveStoredProject(project);
    refreshProjects();
    setScreen({ name: "dashboard" });
  }, [project, refreshProjects]);

  const saveCurrent = useCallback(() => {
    saveStoredProject(project);
    refreshProjects();
  }, [project, refreshProjects]);

  const removeProject = useCallback((id: string) => {
    deleteStoredProject(id);
    refreshProjects();
  }, [refreshProjects]);

  // Auto-save locally on significant changes while in editor (debounced-ish by effect dep).
  useEffect(() => {
    if (screen.name !== "editor") return;
    const t = setTimeout(() => saveStoredProject(project), 1200);
    return () => clearTimeout(t);
  }, [project, screen.name]);

  if (screen.name === "dashboard") {
    return (
      <Dashboard
        projects={projects}
        onNewProject={newProject}
        onOpenProject={openProject}
        onDeleteProject={removeProject}
      />
    );
  }

  return <EditorScreen onHome={goHome} onSaveLocal={saveCurrent} />;
}

export default function App() {
  return (
    <EditorProvider>
      <AppInner />
    </EditorProvider>
  );
}
