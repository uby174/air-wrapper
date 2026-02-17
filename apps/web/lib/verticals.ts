export interface VerticalOption {
  id: string;
  name: string;
  description: string;
}

export const verticalOptions: VerticalOption[] = [
  {
    id: 'legal_contract_analysis',
    name: 'Legal Contract Analysis',
    description: 'Extract risks, obligations, and recommendations from legal agreements.'
  },
  {
    id: 'medical_research_summary',
    name: 'Medical Research Summary',
    description: 'Summarize studies with findings, limitations, and safety notes.'
  },
  {
    id: 'financial_report_analysis',
    name: 'Financial Report Analysis',
    description: 'Analyze reports for key metrics, risks, and executive summary insights.'
  }
];

export const verticalNameById = (id: string): string => {
  const match = verticalOptions.find((option) => option.id === id);
  return match?.name ?? id.replace(/_/g, ' ');
};
