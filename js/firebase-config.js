// ============================================================
// firebase-config.js
// Replace the placeholder values below with your actual Firebase
// project config object from the Firebase console.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getDatabase }   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyB801ub09JewSTwA_T0GkER4YzYvRAcg2E",
  authDomain: "linxzicon-e4d76.firebaseapp.com",
  databaseURL: "https://linxzicon-e4d76-default-rtdb.firebaseio.com",
  projectId: "linxzicon-e4d76",
  storageBucket: "linxzicon-e4d76.firebasestorage.app",
  messagingSenderId: "937731027720",
  appId: "1:937731027720:web:03216a2ae7f4b0996c32bd"
};

// Initialize Firebase app (single instance shared across all modules)
const app      = initializeApp(firebaseConfig);
const auth     = getAuth(app);
const database = getDatabase(app);

export { auth, database };