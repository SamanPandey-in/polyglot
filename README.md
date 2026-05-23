# 🚀 PolyGlot

AI-powered codebase visualizer that maps dependencies, explains architecture, and answers natural language questions about your repository.

---

# 🧠 Features

* 📊 Graph-based code analysis
* 🔗 Dependency visualization
* 🤖 AI-powered explanations (via embeddings)
* 💬 Natural language querying of your codebase
* ⚡ Queue processing with Redis
* 🧩 Vector search using pgvector

---

# 🏗️ Tech Stack

* **Backend:** Node.js + Express
* **Frontend:** SPA (client)
* **Database:** PostgreSQL + pgvector
* **Queue:** Redis (BullMQ)
* **AI:** OpenAI embeddings

---

# 📁 Project Structure

```
polyglot/
├── client/        # Frontend SPA
├── server/        # Backend API
├── docker-compose.yml
└── README.md
```

---

# ⚙️ Local Development Setup

## 1. Install dependencies

### Backend

```bash
cd server
npm install
```

### Frontend

```bash
cd client
npm install
```

---

# 🐳 Docker Setup (Recommended)

This project uses Docker to run:

* PostgreSQL (with pgvector)
* Redis
* Backend

---

## ▶️ Start everything

```bash
docker compose up -d
```

---

## 🛑 Stop everything

```bash
docker compose down
```

---

## 🔄 Reset database (if needed)

```bash
docker compose down -v
```

---

# 🧱 Database Setup

## Run migration (only once)

```bash
psql -h localhost -p 5433 -U postgres -d polyglot -f ./server/src/infrastructure/migrations/001_initial.sql
```

Password:

```
postgres
```

## Add your Postgres server

Inside pgAdmin:

- Right-click “Servers” → Register → Server
- **General tab** Name: local-postgres (or anything)
- **Connection tab** Use your connection string details:

	- Host name/address: host.docker.internal ⚠️ important
	- Port: 5433
	- Username: postgres
	- Password: postgres
	- Database: polyglot

- Why host.docker.internal? Because pgAdmin runs inside a container, and:

	- localhost inside that container ≠ your machine
	- host.docker.internal points to your host machine

---

## 🧠 Notes

* PostgreSQL runs on: `localhost:5433`
* Redis runs on: `localhost:6379`
* Backend runs on: `localhost:3000`

---

# 🔌 Environment Variables (Backend)

Create `server/.env`:

```
DATABASE_URL=postgres://postgres:postgres@postgres:5432/polyglot
REDIS_URL=redis://redis:6379
OPENAI_API_KEY=your_key_here
```

Optional cache tuning:

```
ANALYSIS_HISTORY_CACHE_TTL_SECONDS=60
GRAPH_CACHE_TTL_SECONDS=300
REPOSITORIES_LIST_CACHE_TTL_SECONDS=60
REPOSITORY_JOBS_CACHE_TTL_SECONDS=60
QUERY_AGENT_CACHE_TTL_SECONDS=3600
ENRICHMENT_CACHE_TTL_SECONDS=3600
```

---

# 🧠 Redis Caching + Optimized Retrieval

Implemented Redis-backed cache-aside and invalidation now cover:

- `GET /api/analyze/history`
- `GET /api/graph/:jobId`
- `GET /api/repositories`
- `GET /api/repositories/:id/jobs`

Each endpoint returns `X-Cache: HIT` or `X-Cache: MISS` for easy verification.

Cache invalidation is triggered:

- When a new analysis job is enqueued
- When a job reaches terminal status (`completed`, `failed`, `partial`)

This keeps dashboard/repository/graph reads fast while preserving correctness.

Detailed implementation guide:

- [docs/REDIS_CACHING_AND_DATA_RETRIEVAL.md](docs/REDIS_CACHING_AND_DATA_RETRIEVAL.md)

Quick verification:

1. Call an endpoint above once and confirm `X-Cache: MISS`.
2. Call it again with the same params and confirm `X-Cache: HIT`.
3. Enqueue a new analysis and confirm repository/list endpoints return `MISS` again (cache invalidated).

---

# 🧪 Running Without Docker (optional)

### Start PostgreSQL + Redis manually

Then:

```bash
cd server
npm run migrate
npm run dev
```

---

# 🎨 Frontend (Client)

## Dev mode

```bash
cd client
npm run dev
```

---

## Build for production

```bash
cd client
npm run build
```

---

# 🌐 Production SPA Fallback

To avoid:

```
Cannot GET /analyze
```

---

## ✅ Option 1: Express fallback (already implemented)

In production (`NODE_ENV=production`), backend serves `client/dist`.

### Build frontend:

```bash
cd client
npm run build
```

### Start backend:

```bash
cd server
npm start
```

---

## ✅ Option 2: Nginx (recommended)

```nginx
server {
	listen 80;
	server_name your-domain.com;

	root /var/www/polyglot/client/dist;
	index index.html;

	location /api/ {
		proxy_pass http://127.0.0.1:5000;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_set_header X-Real-IP $remote_addr;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
	}

	location /health {
		proxy_pass http://127.0.0.1:5000;
	}

	location /analyze {
		try_files $uri /index.html;
	}

	location / {
		try_files $uri $uri/ /index.html;
	}
}
```

---

# 🧰 Useful Commands

### View logs

```bash
docker compose logs -f
```

### Restart backend only

```bash
docker compose restart backend
```

### Rebuild containers

```bash
docker compose up -d --build
```

---

# ⚠️ Common Issues

### ❌ `vector extension not available`

✔ Fixed by using pgvector Docker image

---

### ❌ `Cannot GET /route`

✔ Use SPA fallback (Express or Nginx)

---

### ❌ DB connection fails

✔ Ensure backend uses:

```
postgres://postgres:postgres@postgres:5432/polyglot
```

---

# 🚀 Future Improvements

* Migration versioning (Prisma / Knex)
* Auth system expansion
* Multi-repo analysis
* Graph UI enhancements
* Background job monitoring

---

# 🤝 Contributing

PRs welcome. Open an issue first for major changes.

---

# 📜 License

MIT
