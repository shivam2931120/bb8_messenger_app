# Deploying to Vercel (Supabase or Vercel Postgres)

This guide will walk you through deploying your BB84 Messenger App to Vercel.

You can choose between **Option A: Vercel Postgres** (Easiest, integrated) or **Option B: Supabase** (External, robust).

---

## Option A: Vercel Postgres (Recommended)

This is the easiest method because Vercel manages the database and environment variables for you.

### Step 1: Create the Database
1.  Go to your [Vercel Dashboard](https://vercel.com/dashboard).
2.  Click **"Storage"** tab at the top.
3.  Click **"Create Database"** -> Select **"Postgres"**.
4.  Give it a name (e.g., `bb84-db`) and region.
5.  Click **"Create"**.

### Step 2: Deploy & Connect
1.  Go back to "Overview" and click **"Add New..."** -> **"Project"**.
2.  Import your `bb8_messenger_app` repository.
3.  **Configure Project**:
    - **Framework Preset**: Other.
    - **Environment Variables**: Leave empty for now.
    - Click **"Deploy"**. (It might fail or work with SQLite temporarily, don't worry).
4.  Once the project is created, go to the **Project Settings** -> **Storage**.
5.  Click **"Connect Store"** and select the Postgres database you created in Step 1.
6.  check the **"Production"** and **"Preview"** boxes and click **"Connect"**.
7.  **IMPORTANT**: This automatically adds variables like `POSTGRES_URL` to your environment. Your `app.py` is already written to detect this!

### Step 3: Add Secret Key
1.  Go to **Settings** -> **Environment Variables**.
2.  Add `SECRET_KEY` with a random secret string.
3.  Redeploy if needed (Go to **Deployments** -> Click latest -> **Redeploy**).

### Step 4: Initialize Tables
Vercel Postgres needs tables created.
1.  On your local machine, install the Vercel CLI: `npm i -g vercel` (if you have Node) OR just use the Vercel Dashboard's **"Data"** tab.
2.  **Easiest Way (Dashboard)**:
    - Go to your Database in Vercel.
    - Click **"Data"** -> **"Query"**.
    - You can run SQL commands here.
    - Copy the contents of a `schema.sql` (we can generate this if needed) or just run `init_db.py` locally connected to this DB.
3.  **Local Connection Way**:
    - In Vercel Storage tab, looking at "Quickstart", dropdown "psql" to see connection details.
    - Copy the connection string.
    - Paste it into your local `.env` as `DATABASE_URL`.
    - Run `python init_db.py`.

---

## Option B: Supabase

### Step 1: Set up Supabase
1.  Log in to [Supabase](https://supabase.com/dashboard) -> **"New project"**.
2.  Go to **Project Settings** -> **Database**.
3.  Copy the **URI**. (Use port `6543` and "Transaction" mode in Connection Pooler settings for best results).

### Step 2: Configure Vercel
1.  Import project to Vercel.
2.  Add Environment Variable `DATABASE_URL` with your Supabase URI.
3.  Add `SECRET_KEY`.
4.  Deploy.

### Step 3: Initialize
1.  Set `DATABASE_URL` in your local `.env` to the Supabase URL.
2.  Run `python init_db.py` locally.

---

## Troubleshooting

-   **"Relation does not exist"**: You must run `init_db.py` locally (pointed at the remote DB) to create tables.
-   **Socket.IO**: Real-time features use "polling" on Vercel, which works but might be slower than a dedicated server.
