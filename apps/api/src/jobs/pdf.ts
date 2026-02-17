import pdfParse from 'pdf-parse';

export const extractTextFromPdfUrl = async (storageUrl: string): Promise<string> => {
  const response = await fetch(storageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF (${response.status}) from ${storageUrl}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const parsed = await pdfParse(buffer);
  const text = parsed.text.trim();

  if (!text) {
    throw new Error('PDF extraction produced empty text');
  }

  return text;
};
