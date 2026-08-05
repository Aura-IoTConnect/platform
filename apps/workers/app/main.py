from fastapi import FastAPI

from app.ingestion import router as ingestion_router

app = FastAPI(title="iotplatform-workers")
app.include_router(ingestion_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
