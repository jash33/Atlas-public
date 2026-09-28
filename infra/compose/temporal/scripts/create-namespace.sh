#!/bin/sh
set -eu

namespace="${DEFAULT_NAMESPACE:-atlas-development}"
address="${TEMPORAL_ADDRESS:-temporal:7233}"

until temporal operator cluster health --address "$address"; do
  sleep 2
done

if temporal operator namespace describe --namespace "$namespace" --address "$address" >/dev/null 2>&1
then
  echo "Temporal namespace '$namespace' already exists."
else
  temporal operator namespace create --namespace "$namespace" --retention 1d --address "$address"
fi
