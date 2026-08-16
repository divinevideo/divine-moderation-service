// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Provider registry exports - main entry point for moderation providers
// ABOUTME: Re-exports orchestrator functions and provider classes

export { BaseModerationProvider, STANDARD_CAPABILITIES } from './base-provider.mjs';
export { AWSRekognitionProvider } from './aws-rekognition/adapter.mjs';
export { SightengineProvider } from './sightengine/adapter.mjs';
export { BunnyCDNProvider } from './bunnycdn/adapter.mjs';
export { HiveAIProvider } from './hiveai/adapter.mjs';
export { RealityDefenderProvider } from './reality-defender/adapter.mjs';
export {
  getProvider,
  getConfiguredProviders,
  selectProvider,
  moderateWithFallback,
  moderateWithMultiple
} from './orchestrator.mjs';
