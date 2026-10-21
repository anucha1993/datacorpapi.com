-- Update mode labels shown on the website to English
UPDATE usage_prices SET mode_label = 'e-Tracking — application list' WHERE mode = 'etracking';
UPDATE usage_prices SET mode_label = 'Permit application report' WHERE mode = 'permit_report';
UPDATE usage_prices SET mode_label = 'Foreign worker list (account)' WHERE mode = 'aliens';
UPDATE usage_prices SET mode_label = 'Renewal name list (NameList)' WHERE mode = 'namelist_alien';
UPDATE usage_prices SET mode_label = 'Ticket ID check' WHERE mode = 'ticket';
UPDATE usage_prices SET mode_label = 'Receipts / BT.44 / BT.22 forms' WHERE mode = 'receipts';
UPDATE usage_prices SET mode_label = 'Result notice / application receipt' WHERE mode = 'results';
UPDATE usage_prices SET mode_label = 'Payment slips' WHERE mode = 'bill_payment';
UPDATE usage_prices SET mode_label = 'Full receipt set' WHERE mode = 'payment_receipts';
UPDATE usage_prices SET mode_label = 'Acknowledgement / appointment slips' WHERE mode = 'bt30_ctn';
UPDATE usage_prices SET mode_label = 'Card appointment (address from receipt)' WHERE mode = 'appointment';
UPDATE usage_prices SET mode_label = 'Worker registration' WHERE mode = 'register';
UPDATE usage_prices SET mode_label = 'Employer notification (BT.52)' WHERE mode = 'inform';
UPDATE usage_prices SET mode_label = 'MoU permit renewal (BT.30)' WHERE mode = 'bt30';
UPDATE usage_prices SET mode_label = 'Employer change (BT.44)' WHERE mode = 'bt44';
UPDATE usage_prices SET mode_label = 'Appointment slot checker (real-time)' WHERE mode = 'booking_availability';
