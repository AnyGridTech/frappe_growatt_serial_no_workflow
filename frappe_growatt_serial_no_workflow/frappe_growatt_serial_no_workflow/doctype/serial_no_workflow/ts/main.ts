"use strict"
import { DialogInstance } from "@anygridtech/frappe-types/client/frappe/ui/Dialog";
import { SerialNo, SerialNoWorkflow, Workflow } from "@anygridtech/frappe-agt-types/agt/doctype";
import { FrappeForm } from "@anygridtech/frappe-types/client/frappe/core";

/* =========================
  Configurations and constants
  ========================= */

let is_force_state_allowed: boolean = false;

const allowedRoles = [
    'Information Technology',
    'Administrator',
    'System Manager'
];

const OUTPUT_INFO_MESSAGE = {
    SN_NOT_FOUND: __("SN not found."), // pt-BR: SN não encontrado.
    SN_FOUND_ERP: __("SN found in ERPNext database."), // pt-BR: SN encontrado na base do ERPNext.
    SN_FOUND_GROWATT: __("SN found in Growatt database."), // pt-BR: SN encontrado na base da Growatt.
    SN_INVALID: __("Invalid serial number."), // pt-BR: Número de série inválido.
    SN_DUPLICATED: __("Duplicated serial number."), // pt-BR: Número de série duplicado.
    INPUT_VALIDATION_ERROR: __("Input validation error."), // pt-BR: Erro ao validar entrada.
    INVALID_WORKFLOW_TRANSITION: __("Invalid workflow state transition."), // pt-BR: Transição de workflow state inválida.
    MPPT_NOT_SELECTED: __("MPPT not selected."), // pt-BR: Seleção de MPPT requerida.
    ERROR_VALIDATING: __("Error validating."), // pt-BR: Erro ao validar.
    INCOMPLETE_DATA: __("Incomplete data for SN."), // pt-BR: Dados incompletos para o SN.
    PROCESS_ABORTED: __("Process aborted due to incomplete data."), // pt-BR: Processo abortado devido a dados incompletos.
    ERROR_ADDING_SN: __("Error adding serial number."), // pt-BR: Erro ao adicionar número de série.
    FAILED_UPDATE_WORKFLOW: __("Failed to update workflow_state."), // pt-BR: Falha ao atualizar o estado do workflow.
    GENERAL_ERROR: __("General error."), // pt-BR: Erro geral.
    SN_ALREADY_ENTERED: __("This serial number has already been entered."), // pt-BR: Este número de série já foi inserido.
    INVALID_FORM_OR_TABLE: __("Invalid form or table not initialized."), // pt-BR: Formulário inválido ou tabela não inicializada.
    PLEASE_ENTER_SN: __("Please enter a serial number."), // pt-BR: Por favor, insira um número de série.
    PLEASE_SELECT_NEXT_STEP: __("Please select the next workflow step."), // pt-BR: Por favor, selecione o próximo passo do workflow.
    INVALID_FORM: __("Invalid form."), // pt-BR: Formulário inválido.
    ERROR_OPENING_DIALOG: __("Error opening the SN addition window. Check the console for details."), // pt-BR: Erro ao abrir a janela de adição de SN. Verifique o console para detalhes.
    COULD_NOT_START_SCANNER: __("Could not start the scanner. Check camera permissions or if a camera is available."), // pt-BR: Não foi possível iniciar o scanner. Verifique as permissões da câmera ou se uma câmera está disponível.
    FORCE_WORKFLOW_ENABLED: __("Force Workflow state <b>ENABLED</b>.") , // pt-BR: Forçar estado do Workflow <b>ATIVADO</b>.
    FORCE_WORKFLOW_DISABLED: __("Force Workflow state <b>DISABLED</b>.") , // pt-BR: Forçar estado do Workflow <b>DESATIVADO</b>.
    NO_PERMISSION_FORCE_WORKFLOW: __("You do not have permission to force the Workflow state."), // pt-BR: Você não tem permissão para forçar o estado do Workflow.
    ERROR_PROCESSING_FORCE_STATE: __("Error processing force state permission."), // pt-BR: Erro ao processar permissão de forçar estado.
    ERROR_UPDATING_FORM: __("Error updating the form. Check the console."), // pt-BR: Erro ao atualizar o formulário. Verifique o console.
};

/* =========================
  Core helpers
  ========================= */

/**
* Searches items by model, returning an array of objects with item_code, item_name, and mppt
*/
async function get_item_info_by_model(model: string) {
    if (!model) return [];
    // Exact search
    let item_info = await frappe.db.get_list('Item', {
        filters: { item_name: model },
        fields: ['item_code', 'mppt', 'item_name']
    }).catch(() => []);
    // If not found, try normalized search
    if (!item_info || !item_info.length) {
        const all_items = await frappe.db.get_list('Item', {
            fields: ['item_code', 'mppt', 'item_name']
        }).catch(() => []);
        if (all_items && all_items.length) {
            // Normalizes for comparison.
            const normalize = (str: string) => str?.normalize('NFD').replace(/[^\w\s-]/g, '').toLowerCase();
            const normalizedInput = normalize(model);
            item_info = all_items.filter(item => normalize(item.item_name) === normalizedInput);
        }
    }
    return item_info || [];
}

/**
 * Returns the name of the active workflow for 'Serial No' or null
 */
async function getActiveWorkflowName(): Promise<string | null> {
    try {
        const res = await frappe.db.get_list('Workflow', {
            filters: { document_type: 'Serial No', is_active: 1 },
            fields: ['name'],
            limit: 1
        });
        if (!res || !Array.isArray(res) || res.length === 0) return null;
        return res[0]?.name ?? null;
    } catch (e) {
        console.error('Error fetching active workflow:', e);
        return null;
    }
}

/**
 * Loads a Workflow by name (used to get transitions/states)
 */
async function loadWorkflowByName(name: string): Promise<Workflow | null> {
    if (!name) {
        console.warn('loadWorkflowByName called without name.');
        return null;
    }
    // Protect against temporary names of unsaved documents
    if (typeof name === 'string' && name.startsWith('new-')) {
        console.warn('Attempt to fetch workflow with temporary (unsaved) name:', name);
        return null;
    }
    try {
        const resp = await frappe.call<{ docs: Workflow[] }>({
            method: 'frappe.desk.form.load.getdoc',
            args: { doctype: 'Workflow', name }
        });
        if (!resp || !resp.docs || !Array.isArray(resp.docs) || resp.docs.length === 0) return null;
        return resp.docs[0] ?? null;
    } catch (e) {
        console.error('Error loading Workflow:', e);
        return null;
    }
}

/**
 * Ensures the active workflow is loaded or throws an error
 */
async function ensureLoadedWorkflow(): Promise<Workflow> {
    const name = await getActiveWorkflowName();
    if (!name) throw 'Active workflow for Serial No not found.';
    const doc = await loadWorkflowByName(name);
    if (!doc) throw 'Workflow not found.';
    return doc;
}

/**
 * Gets Serial No values from ERPNext (workflow_state, item_code, item_name, company)
 */
async function get_sn_info(serialNumber: string) {
    if (!serialNumber) return null;
    try {
        return await frappe.db
            .get_value<SerialNo>('Serial No', { serial_no: serialNumber }, ['workflow_state', 'item_code', 'item_name', 'company'])
            .then(r => r?.message || null);
    } catch (e) {
        console.error('Error fetching SN info:', e);
        return null;
    }
}

/**
 * Tries to get SN data locally; if not found, queries Growatt and item info
 */
async function CheckSerialNumber(sn: string) {
    let printError = '';
    if (!sn) return { item: undefined, snInfo: undefined, printError: 'Empty SN.' };
    let snInfo;
    try {
        snInfo = await get_sn_info(sn);
    } catch (e) {
        printError = 'Error fetching SN info.';
        return { item: undefined, snInfo: undefined, printError };
    }
    if (!snInfo || Object.keys(snInfo).length === 0) {
        let sn2;
        try {
            sn2 = await agt?.utils?.get_growatt_sn_info?.(sn);
        } catch (e) {
            printError = 'Error fetching SN from Growatt.';
            return { item: undefined, snInfo: undefined, printError };
        }
        if (!sn2 || !sn2.data || !sn2.data.model) return { item: undefined, snInfo: undefined, printError };
        let item;
        try {
            item = await get_item_info_by_model(sn2.data.model);
        } catch (e) {
            printError = 'Error fetching item info.';
            return { item: undefined, snInfo: undefined, printError };
        }
        return { item, snInfo: undefined, printError };
    }
    return { item: {}, snInfo, printError: '' };
}

/**
 * Helper: gets an existing empty row or creates a new row in the 'serial_no_table'
 * Returns the child typed as any to avoid typing issues with frappe.model.add_child
 */
function getOrCreateChildRow(form: FrappeForm<SerialNoWorkflow>) {
    if (!form || !form.doc) throw new Error('Invalid form.');
    if (!Array.isArray(form.doc.serial_no_table)) form.doc.serial_no_table = [];
    const existingEmptyRow = form.doc.serial_no_table.find((c: any) => !c.serial_no);
    if (existingEmptyRow) return existingEmptyRow as any;
    if (!frappe.model?.add_child) throw new Error('frappe.model.add_child not available.');
    const newChild = frappe.model.add_child(form.doc, 'serial_no_table') as any;
    return newChild;
}

/* =========================
  Validation / dialog logic
  ========================= */

/**
 * Validates an individual SN and adds the result to the form table.
 * Returns a summary message (to display in the modal).
 */
async function validateAndAddToForm(
    form: FrappeForm<SerialNoWorkflow>,
    sn_workflow: Workflow,
    serialNumber: string,
    selectedState: string
) {
    // Avoids duplicates already present in the form
    if (!form || !form.doc || !Array.isArray(form.doc.serial_no_table)) {
        return `<b>${serialNumber}:</b>❌ ${OUTPUT_INFO_MESSAGE.INVALID_FORM_OR_TABLE}`;
    }
    if (form.doc.serial_no_table.some((c: any) => c.serial_no === serialNumber)) {
        return `<b>${serialNumber}:</b>❌ ${OUTPUT_INFO_MESSAGE.SN_ALREADY_ENTERED}`;
    }

    let message = '';
    let modelInfo = '';
    let modelName = '';
    let companyName = '';
    let isValid = false;
    let outputInfo = '';
    let snInfo: any = undefined; // Garante que snInfo sempre exista
    // Adds support for multiple models/MPPTs.
    let mpptDialogPromise: Promise<any> | null = null;

    // Basic SN format validation
    if (!agt?.utils?.validate_serial_number?.(serialNumber)) {
        message = `<b>${serialNumber}:</b>⚠️ ${OUTPUT_INFO_MESSAGE.SN_INVALID}`;
        outputInfo = OUTPUT_INFO_MESSAGE.SN_INVALID;
    } else {
        try {
            const { item, snInfo, printError } = await CheckSerialNumber(serialNumber);
            if (printError) {
                message = `<b>${serialNumber}: </b>❌ ${printError}`;
                outputInfo = printError;
                // Adiciona linha na tabela mesmo em caso de erro
                const child: any = getOrCreateChildRow(form);
                child.serial_no = serialNumber;
                child.item_code = '';
                child.item_name = '';
                child.company = '';
                child.next_step = selectedState;
                child.current_workflow_state = '';
                child.output_info = outputInfo;
                child.is_valid = 0;
                form.refresh_field('serial_no_table');
                return message;
            } else if (!snInfo && !item) {
                message = `<b>${serialNumber}: </b>${OUTPUT_INFO_MESSAGE.SN_NOT_FOUND}`;
                outputInfo = OUTPUT_INFO_MESSAGE.SN_NOT_FOUND;
                // Sempre adiciona uma linha para SN_NOT_FOUND, preenchendo campos como string vazia
                const child: any = getOrCreateChildRow(form);
                child.serial_no = serialNumber;
                child.item_code = '';
                child.item_name = '';
                child.company = '';
                child.next_step = selectedState;
                child.current_workflow_state = '';
                child.output_info = outputInfo;
                child.is_valid = 0;
                form.refresh_field('serial_no_table');
                return message;
            } else if (item && snInfo) {
                modelInfo = snInfo.item_code || '';
                modelName = snInfo.item_name || '';
                companyName = snInfo.company || '';
                isValid = true;
                message = `<b>${serialNumber}:</b>✔️ ${__(OUTPUT_INFO_MESSAGE.SN_FOUND_ERP)} (${__("Eq:")} ${modelName}, ${__("Code:")} ${modelInfo})`;
                outputInfo = OUTPUT_INFO_MESSAGE.SN_FOUND_ERP;
            } else if (item && !snInfo) {
                // Always treat item as an array
                const itemList = Array.isArray(item) ? item : [item];
                // If there are multiple possible models/MPPTs, show a dialog for selection
                if (itemList.length > 1 && itemList[0].mppt) {
                    const mpptOptions = itemList.filter((i: any) => i.mppt != null).map((i: any) => i.mppt as string);
                    console.log('*DEBUG* Available MPPT options:', mpptOptions);
                    console.log('*DEBUG* List of returned items:', itemList);
                    const mpptDialogTitle = __('Select the number of MPPTs');
                    mpptDialogPromise = new Promise((resolve) => {
                        agt.utils.dialog.load({
                            title: mpptDialogTitle,
                            fields: [
                                {
                                    fieldname: 'mppt',
                                    label: 'MPPT',
                                    fieldtype: 'Select',
                                    options: mpptOptions,
                                    reqd: true
                                }
                            ],
                            primary_action: function (values: any) {
                                const mppt = values.mppt;
                                console.log('*DEBUG* The MPPT value selected in the dialog box.', mppt);
                                // Robust comparison: both to string and trim
                                const selectedItem = itemList.find((i: any) => String(i.mppt).trim() === String(mppt).trim());
                                console.log('*DEBUG* The item selected after choosing the MPPT:', selectedItem);
                                agt.utils.dialog.close_by_title(mpptDialogTitle);
                                resolve(selectedItem);
                            }
                        });
                    });
                    const selectedItem = await mpptDialogPromise;
                    if (selectedItem && selectedItem.item_code && selectedItem.item_name) {
                        // Only fill after choosing the MPPT and if the item is valid
                        modelInfo = selectedItem.item_code;
                        modelName = selectedItem.item_name;
                        companyName = selectedItem.company || '';
                        isValid = true;
                        message = `<b>${serialNumber}:</b>✔️ ${__(OUTPUT_INFO_MESSAGE.SN_FOUND_GROWATT)} (${__("Eq:")} ${modelName}, ${__("Code:")} ${modelInfo})`;
                        outputInfo = OUTPUT_INFO_MESSAGE.SN_FOUND_GROWATT;
                        // Update table and log only here
                        const child: any = getOrCreateChildRow(form);
                        child.serial_no = serialNumber;
                        child.item_code = modelInfo;
                        child.item_name = modelName;
                        child.company = companyName;
                        child.next_step = selectedState;
                        child.current_workflow_state = '';
                        child.output_info = outputInfo;
                        child.is_valid = 1;
                        form.refresh_field('serial_no_table');
                        return message;
                    } else if (selectedItem) {
                        // Selected, but does not have valid data
                        console.warn('*DEBUG* Selected item does not have valid data:', selectedItem);
                        message = `<b>${serialNumber}: </b>${__(OUTPUT_INFO_MESSAGE.SN_NOT_FOUND)}`;
                        outputInfo = OUTPUT_INFO_MESSAGE.SN_NOT_FOUND;
                        return message;
                    } else {
                        console.warn('*DEBUG* No MPPT was selected in the dialog.');
                        message = `<b>${serialNumber}:</b>❌ ${__(OUTPUT_INFO_MESSAGE.MPPT_NOT_SELECTED)}`;
                        outputInfo = OUTPUT_INFO_MESSAGE.MPPT_NOT_SELECTED;
                        return message;
                    }
                } else if (itemList.length === 1) {
                    // Default case: only one model
                    const realItem = itemList[0];
                    modelInfo = realItem.item_code;
                    modelName = realItem.item_name;
                    companyName = realItem.company || '';
                    isValid = true;
                    message = `<b>${serialNumber}:</b>✔️ ${__(OUTPUT_INFO_MESSAGE.SN_FOUND_GROWATT)} (${__("Eq:")} ${modelName}, ${__("Code:")} ${modelInfo})`;
                    outputInfo = OUTPUT_INFO_MESSAGE.SN_FOUND_GROWATT;
                } else {
                    // No model found
                    message = `<b>${serialNumber}: </b>${__(OUTPUT_INFO_MESSAGE.SN_NOT_FOUND)}`;
                    outputInfo = OUTPUT_INFO_MESSAGE.SN_NOT_FOUND;
                }
            }
            // If found in ERP, validate transition
            if (snInfo && sn_workflow && Array.isArray(sn_workflow.transitions)) {
                const available_transitions = sn_workflow.transitions.filter(
                    (t: any) => t.state === snInfo.workflow_state && t.next_state === selectedState
                );
                if (!available_transitions.length && !is_force_state_allowed) {
                    const allowedStates = sn_workflow.transitions
                        .filter((t: any) => t.state === snInfo.workflow_state)
                        .map((t: any) => t.next_state)
                        .filter((v: any, i: number, self: any) => self.indexOf(v) === i);
                    message = `<b>${serialNumber}:</b>❌ ${__(OUTPUT_INFO_MESSAGE.INVALID_WORKFLOW_TRANSITION)} <b>${__("Current state:")}</b> ${snInfo.workflow_state}, <b>${__("Selected next:")}</b> ${selectedState}. <b>${__("Allowed state(s):")}</b> ${allowedStates.join(', ')}.`;
                    outputInfo = OUTPUT_INFO_MESSAGE.INVALID_WORKFLOW_TRANSITION;
                    isValid = false;
                }
            }
            // Inserts/updates a row in all other cases (ERP, single Growatt model)
            if (modelInfo || modelName) {
                const child: any = getOrCreateChildRow(form);
                child.serial_no = serialNumber;
                child.item_code = modelInfo;
                child.item_name = modelName;
                child.company = companyName;
                child.next_step = selectedState; // stores the target state
                child.current_workflow_state = snInfo?.workflow_state || '';
                child.output_info = outputInfo;
                child.is_valid = isValid ? 1 : 0;
                form.refresh_field('serial_no_table');
            }
        } catch (err) {
            console.error('Error validating SN:', err);
            message = `<b>${serialNumber}:</b>❌ ${__(OUTPUT_INFO_MESSAGE.ERROR_VALIDATING)}`;
            outputInfo = OUTPUT_INFO_MESSAGE.ERROR_VALIDATING;
            const child: any = getOrCreateChildRow(form);
            child.serial_no = serialNumber;
            child.output_info = outputInfo;
            child.is_valid = 0;
            form.refresh_field('serial_no_table');
        }
    }

    // Garante que todo SN validado entre na tabela, inclusive not found (item = [])
    if (!form.doc.serial_no_table.some((c: any) => c.serial_no === serialNumber)) {
        const child: any = getOrCreateChildRow(form);
        child.serial_no = serialNumber;
        child.item_code = modelInfo || '';
        child.item_name = modelName || '';
        child.company = companyName || '';
        child.next_step = selectedState;
        child.current_workflow_state = snInfo?.workflow_state || '';
        child.output_info = outputInfo;
        child.is_valid = isValid ? 1 : 0;
        form.refresh_field('serial_no_table');
    }
    return message;
}

/**
 * Handler for the "Validate" button click in the dialog: reads multiline, iterates SNs and updates modal.
 */
async function handleValidateButtonClick(form: FrappeForm<SerialNoWorkflow>, sn_workflow: Workflow, dialog: DialogInstance) {
    if (!dialog?.get_field) {
        frappe.msgprint('❌ ' + __(OUTPUT_INFO_MESSAGE.INVALID_FORM));
        return;
    }
    const serialNumberField = dialog.get_field('serialno_text-field');
    const raw = serialNumberField?.['get_value']?.() ?? '';
    const serialNumbers = typeof raw === 'string' ? raw.split('\n').map((s: string) => s.trim()).filter((s: string) => s !== '') : [];
    if (!serialNumbers.length) {
        frappe.msgprint('⚠️ ' + __(OUTPUT_INFO_MESSAGE.PLEASE_ENTER_SN));
        return;
    }
    if (!form?.doc) {
        frappe.msgprint('❌ ' + __(OUTPUT_INFO_MESSAGE.INVALID_FORM));
        return;
    }
    const selectedState = form.doc.next_step;
    if (!selectedState) {
        frappe.msgprint('⚠️ ' + __(OUTPUT_INFO_MESSAGE.PLEASE_SELECT_NEXT_STEP));
        return;
    }

    const modal = new agt.ui.UltraDialog({ title: __("Validating SN..."), message: "", visible: false });
    modal.set_state('waiting');

    // tries to block button and close previous dialog (not fatal)
    try {
        dialog.get_field('serialno_validate')['df'].disabled = 1;
        dialog.refresh();
        dialog.hide();
        dialog.clear();
    } catch (e) { console.warn('Failed to handle dialog:', e); }

    try {
        for (const sn of serialNumbers) {
            const msg = await validateAndAddToForm(form, sn_workflow, sn, selectedState);
            modal.set_message(msg);
            modal.visible(true);
            modal.set_state('waiting');
        }
        modal.set_title(__("Analysis Finished"));
        modal.set_message("<div style='color:green;'>✔️ " + __("Process finished!") + "</div>");
        modal.set_state('default');
    } catch (err) {
        modal.set_title(__("Analysis Finished"));
        modal.set_message(`<div style='color:red;'>❌ ${__(OUTPUT_INFO_MESSAGE.GENERAL_ERROR)} ${err}</div>`);
        modal.set_state('default');
    } finally {
        try { dialog.get_field('serialno_validate')['df'].disabled = 0; dialog.refresh(); } catch (e) { console.warn('Failed to re-enable button:', e); }
    }
}

/* =========================
  processSerialNumbers (persistence/execution)
  ========================= */

async function processSerialNumbers(form: FrappeForm<SerialNoWorkflow>) {
    const activeWorkflowName = await getActiveWorkflowName();
    if (!activeWorkflowName) throw 'Active workflow for Serial No not found.';

    const workflowDoc = await frappe.db.get_doc<Workflow>('Workflow', activeWorkflowName);
    const initialState = workflowDoc.states?.[0]?.state;
    if (!initialState) frappe.throw(__("Initial Workflow state not found."));

    const outputsMap: Record<string, boolean> = {
        [OUTPUT_INFO_MESSAGE.SN_FOUND_ERP]: true,
        [OUTPUT_INFO_MESSAGE.SN_FOUND_GROWATT]: true,
        [OUTPUT_INFO_MESSAGE.INVALID_WORKFLOW_TRANSITION]: !!form.doc.checkbox_force_state,
        [OUTPUT_INFO_MESSAGE.SN_NOT_FOUND]: true,
    };

    const successfulSerialNumbers = form.doc.serial_no_table.filter((row: any) => outputsMap[row.output_info]);
    const allSerials = successfulSerialNumbers.map((r: any) => r.serial_no);

    if (!allSerials.length) {
        // nothing to process
        return;
    }

    const existingRecords = await frappe.db.get_list('Serial No', {
        fields: ['serial_no', 'name', 'workflow_state'],
        filters: { serial_no: ['in', allSerials] },
    });
    // Fix: compare by serial_no field, not by name
    const existingSNSet = new Set(existingRecords.map((i: any) => i.serial_no));

    const operations: { sn: string; isNew: boolean; targetState: string; }[] = [];

    for (const row of successfulSerialNumbers) {
        if (!row.serial_no || !row.next_step) {
            frappe.msgprint(`❌ ${__("Incomplete data for SN")}: ${row.serial_no}.`);
            throw __("Process aborted due to incomplete data.");
        }
        const currentState = row.current_workflow_state || initialState;
        let targetState: string;
        let isNew = false;

        if (!existingSNSet.has(row.serial_no)) {
            isNew = true;
            targetState = row.next_step;
        } else {
            const transition = workflowDoc.transitions.find((t: any) => t.state === currentState && t.next_state === row.next_step);
            if (transition) {
                targetState = transition.next_state;
            } else if (is_force_state_allowed) {
                targetState = row.next_step;
            } else {
                const allowedStates = workflowDoc.transitions
                    .filter((t: any) => t.state === currentState)
                    .map((t: any) => t.next_state)
                    .filter((v: any, i: number, self: any) => self.indexOf(v) === i);
                frappe.msgprint(
                    `❌ ${__("Invalid state transition for SN")}: ${row.serial_no}. ${__("Current state")}: ${currentState}, ${__("Selected next")}: ${row.next_step}. ${__("Allowed")}: ${allowedStates.join(', ')}.`
                );
                throw __("Process aborted due to invalid transition for existing SN.");
            }
        }
        operations.push({ sn: row.serial_no, isNew, targetState });
    }

    // Execute operations
    for (const op of operations) {
        if (op.isNew) {
            try {
                const correspondingRow = successfulSerialNumbers.find((r: any) => r.serial_no === op.sn);
                const newSN = await frappe.db.insert({
                    doctype: 'Serial No',
                    serial_no: op.sn,
                    item_code: correspondingRow?.item_code,
                    item_name: correspondingRow?.item_name,
                    company: correspondingRow?.company,
                    workflow_state: initialState,
                });
                if (newSN) {
                    frappe.msgprint(`✔️ ${__("Serial Number")}: ${op.sn} ${__("was successfully added to the database.")}`);
                    form.doc.serial_no_table.filter((c: any) => c.serial_no === op.sn).forEach((c: any) => c.is_success = 1);
                    form.refresh_field('serial_no_table');

                    // Fix: use the name of the new document created to update workflow_state
                    await agt.utils.update_workflow_state({
                        doctype: "Serial No",
                        docname: newSN.name || newSN, // fallback in case a string is returned
                        workflow_state: op.targetState,
                        ignore_workflow_validation: true
                    });
                    console.log(`Workflow state updated to ${op.targetState} for new SN ${op.sn}.`);
                }
            } catch (err) {
                console.error(`Error adding SN ${op.sn}:`, err);
                frappe.msgprint(`❌ ${__("Error adding serial number")}: ${op.sn}.`);
                throw err;
            }
        } else {
            try {
                // Fix: get the document name by serial_no
                const existing = existingRecords.find((i: any) => i.serial_no === op.sn);
                const docname = existing?.name || op.sn;
                await agt.utils.update_workflow_state({
                    doctype: 'Serial No',
                    docname,
                    workflow_state: op.targetState,
                    ignore_workflow_validation: !!form.doc.checkbox_force_state,
                });
                console.log(`Workflow state updated to ${op.targetState} for existing SN ${op.sn}.`);
            } catch (err) {
                console.error(`Error updating workflow state for SN ${op.sn}:`, err);
                frappe.msgprint(`❌ ${__("Failed to update workflow_state to")} ${op.targetState} ${__("for SN")}: ${op.sn}.`);
                throw err;
            }
        }
    }

    form.refresh_field('serial_no_table');
}

/* =========================
  Form handler registration (consolidated)
  ========================= */

frappe.ui.form.on('Serial No Workflow', {
    refresh: async function (form: FrappeForm<SerialNoWorkflow>) {
        agt.utils.form.set_button_primary_style(form, 'add_sn');
        try {
            if (!form?.set_df_property) throw new Error('form.set_df_property não disponível.');
            form.set_df_property('next_step', 'options', []);
            // loads workflow and populates next_step options according to user roles
            const sn_workflow = await ensureLoadedWorkflow();
            const user_roles = Array.isArray(frappe.boot?.user?.roles) ? frappe.boot.user.roles : [];
            const transitions = Array.isArray(sn_workflow?.transitions) ? sn_workflow.transitions : [];
            const next_step_options = Array.from(new Set(
                transitions.filter((t: any) => user_roles.includes(t.allowed)).map((t: any) => t.next_state)
            ));
            form.set_df_property('next_step', 'options', next_step_options);
            // binds add_sn button (single listener)
            if (
                typeof form.fields_dict?.['add_sn']?.$wrapper?.off === 'function' &&
                typeof form.fields_dict['add_sn'].$wrapper.on === 'function'
            ) {
                form.fields_dict['add_sn'].$wrapper.off('click').on('click', () => {
                    try {
                        if (!agt?.utils?.dialog?.load) throw new Error('agt.utils.dialog.load não disponível.');
                        const dialog = agt.utils.dialog.load({
                            title: __("Add SN"),
                            fields: [
                                {
                                    label: `<b>📷 ${__("Scan barcode")}</b><p><span class="text-muted small" style="font-size: 0.7em;">${__("Click to activate the barcode scanner.")}</span></p>`,
                                    // Garante tradução correta: texto puro dentro do __()
                                    // Se necessário, pode-se separar ainda mais:
                                    // const scanLabel = __("Scan barcode");
                                    // const scanHint = __("Click to activate the barcode scanner.");
                                    // label: `<b>📷 ${scanLabel}</b><p><span class="text-muted small" style="font-size: 0.7em;">${scanHint}</span></p>`,
                                    fieldname: 'serialno_scan-barcode',
                                    fieldtype: 'Button',
                                    click: () => {
                                        try {
                                            if (!frappe?.ui?.Scanner) throw new Error('frappe.ui.Scanner não disponível.');
                                            new frappe.ui.Scanner({
                                                dialog: true,
                                                multiple: false,
                                                on_scan(data) {
                                                    if (data?.result?.text) {
                                                        const snField = dialog?.get_field('serialno_text-field');
                                                        const currentValue = snField?.['get_value']?.() || '';
                                                        const newValue = currentValue ? `${currentValue}\n${data.result.text}` : data.result.text;
                                                        snField?.['set_input']?.(newValue);
                                                    }
                                                }
                                            });
                                        } catch (scannerError) {
                                            console.error("Error initializing scanner:", scannerError);
                                            frappe.msgprint(__(OUTPUT_INFO_MESSAGE.COULD_NOT_START_SCANNER));
                                        }
                                    }
                                },
                                {
                                    label: `<b>${__("Serial Number")}</b>`,
                                    fieldname: 'serialno_text-field',
                                    fieldtype: 'Text',
                                    placeholder: __("Enter the serial number manually or scan the barcode."),
                                },
                                {
                                    label: __("Validate"),
                                    fieldname: 'serialno_validate',
                                    fieldtype: 'Button',
                                    primary: true,
                                    click: async () => {
                                        await handleValidateButtonClick(form, sn_workflow, dialog);
                                    }
                                }
                            ],
                            static: false,
                            lockClose: true,
                            draggable: true,
                        });
                    } catch (err) {
                        console.error("Error opening 'Add SN' dialog:", err);
                        frappe.msgprint(OUTPUT_INFO_MESSAGE.ERROR_OPENING_DIALOG);
                    }
                });
            }
            // closes open dialogs (original behavior)
            agt?.utils?.dialog?.close_all?.();
        } catch (e) {
            console.error('Error refreshing form:', e);
            frappe.msgprint('❌ ' + __(OUTPUT_INFO_MESSAGE.ERROR_UPDATING_FORM));
        }
    },

    // Keeps next_step handler registered (no additional action for now)
    next_step: function (form: FrappeForm<SerialNoWorkflow>) {
        form.refresh_field('next_step');
    },

    validate: async function (form: FrappeForm<SerialNoWorkflow>) {
        await processSerialNumbers(form);
    },

    checkbox_force_state: function (frm) {
        try {
            const userRoles = Array.isArray(frappe.boot?.user?.roles) ? frappe.boot.user.roles : [];
            const userHasPermission = allowedRoles.some(role => userRoles.includes(role));
            if (userHasPermission) {
                is_force_state_allowed = !!frm?.doc?.checkbox_force_state;
                frappe.msgprint({ message: __(is_force_state_allowed ? OUTPUT_INFO_MESSAGE.FORCE_WORKFLOW_ENABLED : OUTPUT_INFO_MESSAGE.FORCE_WORKFLOW_DISABLED) });
                console.log("is_force_state_allowed updated to:", is_force_state_allowed);
            } else {
                is_force_state_allowed = false;
                if (frm?.doc?.checkbox_force_state === 1 && frm.set_value) {
                    frm.set_value('checkbox_force_state', 0);
                    frappe.msgprint({ message: __(OUTPUT_INFO_MESSAGE.NO_PERMISSION_FORCE_WORKFLOW) });
                }
            }
        } catch (e) {
            is_force_state_allowed = false;
            console.error('Error processing checkbox_force_state:', e);
            frappe.msgprint({ message: __(OUTPUT_INFO_MESSAGE.ERROR_PROCESSING_FORCE_STATE) });
        }
    }
});
