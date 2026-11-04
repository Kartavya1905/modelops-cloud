"""Create the platform's S3 buckets if they do not exist yet.

Runs as the one-shot `storage-init` Compose service. Safe to run any number of times:
an existing bucket is left untouched.
"""

import os
import sys
import time

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, EndpointConnectionError


def main() -> int:
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["MO_S3_ENDPOINT"],
        aws_access_key_id=os.environ["MO_S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["MO_S3_SECRET_KEY"],
        region_name=os.environ.get("MO_S3_REGION", "us-east-1"),
        config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 3}),
    )
    buckets = [b.strip() for b in os.environ["MO_BUCKETS"].split(",") if b.strip()]

    # The S3 gateway can report healthy slightly before the filer accepts writes.
    for attempt in range(1, 11):
        try:
            existing = {b["Name"] for b in s3.list_buckets().get("Buckets", [])}
            break
        except (EndpointConnectionError, ClientError) as exc:
            print(f"storage-init: waiting for S3 (attempt {attempt}): {exc}", flush=True)
            time.sleep(2)
    else:
        print("storage-init: S3 not reachable, giving up", file=sys.stderr)
        return 1

    for name in buckets:
        if name in existing:
            print(f"storage-init: bucket '{name}' already exists")
            continue
        s3.create_bucket(Bucket=name)
        print(f"storage-init: created bucket '{name}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
