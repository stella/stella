import {
  assertThirdPartyOutboundPermit,
  type ThirdPartyOutboundPermit,
} from "@/api/lib/auth/third-party-outbound-permit";
import { outboundRequests } from "@/api/lib/safe-outbound-fetch";

type FetchWithResolvedAddressOptions = Parameters<
  typeof outboundRequests.resolvedBytes
>[0] & {
  permit: ThirdPartyOutboundPermit;
};

export const fetchWithResolvedAddress = async ({
  permit,
  ...options
}: FetchWithResolvedAddressOptions) => {
  assertThirdPartyOutboundPermit(permit);
  return await outboundRequests.resolvedBytes(options);
};

type FetchStreamWithResolvedAddressOptions = Parameters<
  typeof outboundRequests.resolvedStream
>[0] & {
  permit: ThirdPartyOutboundPermit;
};

export const fetchStreamWithResolvedAddress = async ({
  permit,
  ...options
}: FetchStreamWithResolvedAddressOptions) => {
  assertThirdPartyOutboundPermit(permit);
  return await outboundRequests.resolvedStream(options);
};

type SafeOutboundFetchBytesOptions = Parameters<
  typeof outboundRequests.bytes
>[0] & {
  permit: ThirdPartyOutboundPermit;
};

export const safeOutboundFetchBytes = async ({
  permit,
  ...options
}: SafeOutboundFetchBytesOptions) => {
  assertThirdPartyOutboundPermit(permit);
  return await outboundRequests.bytes(options);
};

type SafeOutboundFetchStreamOptions = Parameters<
  typeof outboundRequests.stream
>[0] & {
  permit: ThirdPartyOutboundPermit;
};

export const safeOutboundFetchStream = async ({
  permit,
  ...options
}: SafeOutboundFetchStreamOptions) => {
  assertThirdPartyOutboundPermit(permit);
  return await outboundRequests.stream(options);
};
