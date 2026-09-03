// Textes rendus (français) des notifications, centralisés pour rester cohérents
// entre le déclencheur de soumission (EventsService) et celui de décision
// (EventModerationService).
export const notificationText = {
  eventSubmitted: (eventTitle: string) => ({
    title: `« ${eventTitle} » soumis à validation`,
    body: "Ton événement est en cours de modération. On te prévient dès qu'il est validé.",
  }),
  eventPublished: (eventTitle: string) => ({
    title: `« ${eventTitle} » est publié 🎉`,
    body: 'Ton événement est en ligne, les participants peuvent réserver leurs billets.',
  }),
  eventRejected: (eventTitle: string) => ({
    title: `« ${eventTitle} » n'a pas été validé`,
    body: "Ton événement n'a pas passé la modération. Contacte l'équipe Vybe pour en savoir plus.",
  }),
};
