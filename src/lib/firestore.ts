/**
 * Firebase Auth + Cloud Firestore persistence for project timeline JSON.
 * Media stays local/B2; only project metadata and timeline structure is stored.
 */
import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from "firebase/auth";
import { doc, getDoc, getFirestore, serverTimestamp, setDoc, type Firestore } from "firebase/firestore";
import type { Project } from "../types/editor";

const COLLECTION = "projects";

interface FirebaseEnv {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

function readEnv(): FirebaseEnv | null {
  const env = import.meta.env;
  const apiKey = env.VITE_FIREBASE_API_KEY as string | undefined;
  const authDomain = env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined;
  const projectId = env.VITE_FIREBASE_PROJECT_ID as string | undefined;
  const appId = env.VITE_FIREBASE_APP_ID as string | undefined;
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return { apiKey, authDomain, projectId, appId };
}

const config = readEnv();
export const firebaseConfigured = config !== null;

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

function ensure(): { auth: Auth; db: Firestore } {
  if (!config) throw new Error("Firebase is not configured. Add VITE_FIREBASE_* values to .env.local.");
  if (!app) {
    app = initializeApp({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId, appId: config.appId });
    auth = getAuth(app);
    db = getFirestore(app);
  }
  if (!auth || !db) throw new Error("Firebase failed to initialise.");
  return { auth, db };
}

export function watchUser(callback: (user: { uid: string; email: string | null; name: string | null } | null) => void): () => void {
  if (!config) {
    callback(null);
    return () => {};
  }
  const { auth: a } = ensure();
  return onAuthStateChanged(a, (user: User | null) => {
    callback(user ? { uid: user.uid, email: user.email, name: user.displayName } : null);
  });
}

export async function signInWithGoogle(): Promise<void> {
  const { auth: a } = ensure();
  await signInWithPopup(a, new GoogleAuthProvider());
}

export async function signOut(): Promise<void> {
  if (!config) return;
  const { auth: a } = ensure();
  await firebaseSignOut(a);
}

function flattenClips(project: Project) {
  const clips: { id: string; name: string; in: number; out: number }[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      clips.push({ id: clip.id, name: clip.name, in: clip.start, out: clip.start + clip.duration });
      if (clips.length >= 500) return clips;
    }
  }
  return clips;
}

export function projectPayload(project: Project, uid: string) {
  // Sanitize runtime-only fields (File refs, blob URLs).
  const safe: Project = {
    ...project,
    assets: project.assets.map((a) => ({ ...a, file: undefined, src: a.src.startsWith("blob:") ? "" : a.src })),
  };
  return {
    // Fields required by existing rules for compatibility.
    id: safe.id,
    title: safe.title,
    aspect: safe.settings.aspect,
    clips: flattenClips(safe),
    version: 1,
    // Rich multi-track payload.
    schema: 2,
    settings: safe.settings,
    tracks: safe.tracks,
    assets: safe.assets,
    thumbnailDataUrl: safe.thumbnailDataUrl ?? null,
    createdAt: safe.createdAt,
    projectUpdatedAt: safe.updatedAt,
    userId: uid,
    updatedAt: serverTimestamp(),
  };
}

export function projectSize(project: Project, uid = "u"): number {
  return new Blob([JSON.stringify(projectPayload(project, uid))]).size;
}

export async function saveProject(project: Project, uid: string): Promise<void> {
  const { db: database } = ensure();
  const payload = projectPayload(project, uid);
  const size = new Blob([JSON.stringify({ ...payload, updatedAt: 0 })]).size;
  if (size > 950 * 1024) {
    throw new Error("Project document is too large to save as one Firestore document. Reduce assets/clips or save locally.");
  }
  await setDoc(doc(database, COLLECTION, project.id), payload, { merge: false });
}

export async function loadProject(id: string): Promise<Project | null> {
  const { db: database } = ensure();
  const snap = await getDoc(doc(database, COLLECTION, id));
  if (!snap.exists()) return null;
  const data = snap.data() as Record<string, unknown>;
  if (data.schema === 2 && Array.isArray(data.tracks)) {
    return {
      id: String(data.id ?? snap.id),
      title: String(data.title ?? "Untitled Project"),
      createdAt: Number(data.createdAt ?? Date.now()),
      updatedAt: Number(data.projectUpdatedAt ?? Date.now()),
      settings: (data.settings as Project["settings"]) ?? { aspect: "16:9", width: 1920, height: 1080, fps: 30, background: "#000000" },
      assets: Array.isArray(data.assets) ? (data.assets as Project["assets"]) : [],
      tracks: data.tracks as Project["tracks"],
      thumbnailDataUrl: typeof data.thumbnailDataUrl === "string" ? data.thumbnailDataUrl : undefined,
    };
  }
  // Legacy v1 fallback.
  return null;
}
