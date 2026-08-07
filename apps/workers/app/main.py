from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI

from app.agents_routes import router as agents_router
from app.ingestion import router as ingestion_router

app = FastAPI(title="iotplatform-workers")
app.include_router(ingestion_router)
app.include_router(agents_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
