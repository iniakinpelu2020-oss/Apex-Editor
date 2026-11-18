/**
 * Firebase Auth + Cloud Firestore — the only persistence in Apex Editor.
 *
 * Supabase was removed on purpose: its free tier pauses a project after about a
 * week of inactivity, and an editor you open once a month is exactly that shape
 * of project. Firestore does not pause, and Firebase Auth was already the sign-in
 * gate, so this drops a vendor instead of adding one.
 *
 * What is stored: the project document, which is timeline JSON only. Raw media
 * never goes here — it stays local (OPFS/IndexedDB) or in B2 via presigned URLs.
 *
 * Security is in firestore.rules, not in this file. Nothing here can grant access
 * the rules deny, and nothing here tries.
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
import {
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
  type Firestore,
} from "firebase/firestore";

export interface ProjectDoc {
  /** Stable id for the project — the Firestore document id. */
  id: string;
  title: string;
  aspect: "16:9" | "9:16" | "1:1";
  clips: {
    id: string;
    name: string;
    in: number;
    out: number;
  }[];
  /** Schema version, so an old document can be migrated rather than guessed at. */
  version: 1;
  updatedAt?: unknown;
  userId?: string;
}

/** The document path is projects/{projectId}. Keep the size well under 100 KB. */
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
  if (!config) throw new Error("Firebase is not configured. Add the VITE_FIREBASE_* values to .env.local.");
  if (!app) {
    app = initializeApp({
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      appId: config.appId,
    });
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
  const provider = new GoogleAuthProvider();
  // A popup rather than a redirect: the editor holds an imported clip in memory,
  // and a redirect would throw it away mid-session.
  await signInWithPopup(a, provider);
}

export async function signOut(): Promise<void> {
  if (!config) return;
  const { auth: a } = ensure();
  await firebaseSignOut(a);
}

/** Rough byte size of the serialised project, to keep documents small. */
export function projectSize(project: ProjectDoc): number {
  return new Blob([JSON.stringify(project)]).size;
}

export async function saveProject(project: ProjectDoc, uid: string): Promise<void> {
  const { db: database } = ensure();
  if (projectSize(project) > 100 * 1024) {
    throw new Error("This project is too large for one Firestore document (over 100 KB). Trim the clip list.");
  }
  // userId is written from the caller's own uid. The rules require that it
  // matches request.auth.uid, so a forged value is rejected server-side rather
  // than trusted here.
  await setDoc(
    doc(database, COLLECTION, project.id),
    {
      ...project,
      userId: uid,
      updatedAt: serverTimestamp(),
    },
    { merge: false }
  );
}

export async function loadProject(id: string): Promise<ProjectDoc | null> {
  const { db: database } = ensure();
  const snap = await getDoc(doc(database, COLLECTION, id));
  if (!snap.exists()) return null;
  const data = snap.data() as ProjectDoc;
  return { ...data, id: snap.id };
}
