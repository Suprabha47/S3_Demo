from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import boto3
import os
from dotenv import load_dotenv
from botocore.config import Config
from botocore.exceptions import ClientError
from typing import List

load_dotenv()

app = FastAPI(title="S3 Multipart Upload API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # change to frontend URL later
    allow_credentials=True,    # Allow browser requests that use credentials, such as cookies or HTTP authentication
    allow_methods=["*"],       # Allow all HTTP methods for cross-origin requests, subject to CORS rules
    allow_headers=["*"]        # Allow all request headers for cross-origin requests
)

s3_client = boto3.client(
    "s3",
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
    region_name=os.getenv("AWS_REGION"),
    config=Config(
        signature_version="s3v4",
        s3={"addressing_style": "virtual"}
    )
)

BUCKET = os.getenv("S3_BUCKET")

# # ---------- Request Models ----------
class InitiateRequest(BaseModel):
    filename: str
    content_type: str = "application/pdf"

class PresignPartRequest(BaseModel):
    upload_id: str
    key: str
    part_number: int

class CompletePart(BaseModel):
    ETag: str
    PartNumber: int

class CompleteRequest(BaseModel):
    upload_id: str
    key: str
    parts: list[CompletePart]

class DownloadRequest(BaseModel):
    key: str

# # ---------- Endpoints ----------

@app.post("/initiate")
def initiate_upload(req: InitiateRequest):
    """Start a multipart upload and return UploadId + Key"""
    try:
        key = f'uploads/{req.filename}'

        response = s3_client.create_multipart_upload(
            Bucket=BUCKET,
            Key=key,
            ContentType=req.content_type
        )

        return {
            "upload_id": response["UploadId"],
            "key": key
        }
    except ClientError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/presign-part")
def get_presigned_url(req: PresignPartRequest):
    """Generate a presigned URL for uploading one part"""
    try:
        url = s3_client.generate_presigned_url(
            ClientMethod = "upload_part",
            Params = {
                "Bucket": BUCKET,
                "Key": req.key,
                "UploadId":req.upload_id,
                "PartNumber": req.part_number
            },
            ExpiresIn=3600, # 1 Hour
        )
        return {"url":url}
    except ClientError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/complete")
def complete_upload( req: CompleteRequest):
    """Complete the multipart upload"""
    try:
        parts = [{"ETag": p.ETag, "PartNumber": p.PartNumber} for p in req.parts]

        response = s3_client.complete_multipart_upload(
            Bucket= BUCKET,
            Key= req.key,
            UploadId= req.upload_id,
            MultipartUpload= {"Parts": parts}
        )

        return {
            "message": "Upload completed successfully",
            "location": response.get("Location"),
            "key": req.key
        }

    except ClientError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/abort")
def abort_upload(upload_id:str, key:str):
    """Abort an incomplete multipart upload"""
    try:
        s3_client.abort_multipart_upload(
            Bucket= BUCKET,
            Key= key,
            UploadId= upload_id
        )
        return {"message": "Upload aborted"}

    except ClientError as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/files")
def list_files():
    """List all uploaded files"""
    try:
        response = s3_client.list_objects_v2(
            Bucket=BUCKET,
            Prefix="uploads/"
        )

        files = []
        if "Contents" in response:
            for obj in response["Contents"]:
                if obj["Key"].endswith("/"):  # skip folders
                    continue
                files.append({
                    "key": obj["Key"],
                    "filename": obj["Key"].replace("uploads/", ""),
                    "size": obj["Size"],
                    "last_modified": obj["LastModified"].isoformat(),
                })

        # Sort by latest first
        files.sort(key=lambda x: x["last_modified"], reverse=True)
        return {"files": files}

    except ClientError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/presign-download")
def get_download_url(req: DownloadRequest):
    """Generate a temporary download URL (valid for 1 hour)"""
    try:
        url = s3_client.generate_presigned_url(
            ClientMethod="get_object",
            Params={
                "Bucket": BUCKET,
                "Key": req.key,
            },
            ExpiresIn=3600,  # 1 hour
        )
        return {"download_url": url}
    except ClientError as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/")
def health():
    return {"status": "Backend is running"}
