// ============================================================
// auth.js
// Firebase Authentication: register, login, logout.
// Also provides helpers for guarding pages that require login.
// ============================================================

import { auth }                             from "./firebase-config.js";
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { createAccount } from "./account.js";

// ============================================================
// register
// Creates a Firebase Auth user AND writes their Account record
// to the Realtime Database.
// Returns the new Account object on success.
// Throws on failure — catch in the calling UI code.
// ============================================================
export async function register(username, email, password) {
    if (!username || username.trim().length < 2) {
        throw new Error("Username must be at least 2 characters.");
    }

    const cred    = await createUserWithEmailAndPassword(auth, email, password);
    const account = await createAccount(cred.user.uid, username.trim(), email);
    return account;
}

// ============================================================
// login
// Signs in with email + password.
// Returns the Firebase user credential on success.
// Throws on failure — catch in the calling UI code.
// ============================================================
export async function login(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
}

// ============================================================
// logout
// Signs out and redirects to the landing page.
// ============================================================
export async function logout() {
    await signOut(auth);
    window.location.href = "index.html";
}

// ============================================================
// getCurrentUser
// Returns the currently signed-in Firebase user, or null.
// ============================================================
export function getCurrentUser() {
    return auth.currentUser;
}

// ============================================================
// requireAuth
// Call at the top of any protected page.
// Waits for Firebase to confirm auth state, then either
// returns the user or redirects to index.html.
// ============================================================
export function requireAuth() {
    return new Promise((resolve) => {
        // onAuthStateChanged fires once immediately with the current state
        const unsub = onAuthStateChanged(auth, (user) => {
            unsub(); // unsubscribe after the first event to avoid leaking listeners
            if (!user) {
                window.location.href = "index.html";
            } else {
                resolve(user);
            }
        });
    });
}

// ============================================================
// onAuthChange
// Subscribe to ongoing auth state changes (login / logout).
// Returns the unsubscribe function.
// ============================================================
export function onAuthChange(callback) {
    return onAuthStateChanged(auth, callback);
}