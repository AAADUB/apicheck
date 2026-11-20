import type {Provider} from '../types';
import {lambda} from './lambda';
import {upcloud} from './upcloud';
import {nebius} from './nebius';
import {runpod} from './runpod';
import {hyperstack} from './hyperstack';
import {fake} from './fake';
export const PROVIDERS: Record<string, Provider> = {lambda, upcloud, nebius, runpod, hyperstack, fake};
