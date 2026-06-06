/**
 * Style presets.
 *
 * Every prompt template embeds strong identity-preservation guardrails. The
 * shared IDENTITY_GUARDRAILS block is appended to each preset's stylistic
 * prompt so the model improves grooming/lighting/outfit/composition WITHOUT
 * altering the subject's facial identity, age, ethnicity, structure, or gender
 * expression.
 */

export interface StylePreset {
  id: string;
  name: string;
  description: string;
  promptTemplate: string;
  category: string;
}

const IDENTITY_GUARDRAILS = [
  'Preserve the subject\'s exact facial identity and resemblance from the reference photos.',
  'Photorealistic photography with natural, realistic skin texture and pores — no plastic or over-smoothed skin.',
  'Improve lighting, grooming, outfit, and composition only.',
  'Do NOT change the person\'s age, ethnicity, facial structure, bone structure, or gender expression.',
  'Keep the same hairline, eye shape, nose, and jaw. The output must be unmistakably the same person.',
  'No exaggerated retouching, no beauty filters, no face slimming.',
].join(' ');

function buildPrompt(style: string): string {
  return `${style} ${IDENTITY_GUARDRAILS}`.trim();
}

export const PRESETS: StylePreset[] = [
  {
    id: 'casual-smart',
    name: 'Casual Smart',
    description: 'Relaxed yet polished everyday look with flattering natural light.',
    category: 'lifestyle',
    promptTemplate: buildPrompt(
      'A smart-casual portrait: well-fitted casual outfit (clean shirt or knit), tidy grooming, soft natural daylight, gentle shallow depth of field, neutral modern background.',
    ),
  },
  {
    id: 'business-elite',
    name: 'Business Elite',
    description: 'Executive headshot with sharp tailoring and confident studio lighting.',
    category: 'professional',
    promptTemplate: buildPrompt(
      'A premium corporate headshot: tailored suit or blazer, crisp grooming, professional studio lighting with soft key and subtle rim light, clean neutral or office background, confident composed expression.',
    ),
  },
  {
    id: 'outdoor-adventure',
    name: 'Outdoor Adventure',
    description: 'Energetic outdoor portrait with golden-hour light and natural scenery.',
    category: 'lifestyle',
    promptTemplate: buildPrompt(
      'An outdoor adventure portrait: rugged-yet-clean casual wear, golden-hour sunlight, scenic natural background (mountains, forest, or coast), candid energetic feel, crisp and vibrant.',
    ),
  },
  {
    id: 'luxury-lifestyle',
    name: 'Luxury Lifestyle',
    description: 'Upscale editorial look with refined styling and cinematic tones.',
    category: 'editorial',
    promptTemplate: buildPrompt(
      'A luxury lifestyle editorial portrait: refined high-end outfit and accessories, polished grooming, cinematic warm tones, elegant upscale setting (luxury interior, rooftop, or premium car), magazine-quality composition.',
    ),
  },
];

const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

export function listPresets(): StylePreset[] {
  return PRESETS;
}

export function getPreset(id: string): StylePreset | undefined {
  return PRESET_BY_ID.get(id);
}
